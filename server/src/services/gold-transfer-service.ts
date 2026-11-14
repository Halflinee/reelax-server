// 每次确认只执行已预览的装备与金额。请求结果不明确时停在待核对状态，不重新交易。
import { z } from "zod";
import { HttpError } from "../api/server.ts";
import type { Repos } from "../db/repositories/index.ts";
import type { GoldTransfer, GoldSettlement } from "../db/repositories/gold-transfers.ts";
import type { AccountService } from "./account-service.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { GameClient } from "../game/client.ts";
import { AUDIT_ACTIONS } from "../db/repositories/audit.ts";
import { TradePreviewService, type TradePreview } from "./trade-preview-service.ts";

const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tradeSchema = z.object({
  id: z.string().min(1), role: z.enum(["buyer", "seller"]), quantity: z.number().int().positive(), gross: amount,
  fee: amount.nullish(), sellerProceeds: amount.nullish(),
  asset: z.object({ type: z.literal("gear"), gear: z.object({ id: z.string().min(1) }) }),
});
const tradesSchema = z.object({ trades: z.array(tradeSchema) });
const ordersSchema = z.object({ orders: z.array(z.object({
  id: z.string().min(1), status: z.string(), limitUnitPrice: amount,
  asset: z.object({ type: z.literal("gear"), gear: z.object({ id: z.string().min(1) }) }),
})), nextCursor: z.string().min(1).nullish() });
const profileSchema = z.object({ player: z.object({ id: z.string().min(1) }) });
const feeSchema = z.object({ sellerFeeBasisPoints: z.number().int().min(0).max(10000) });

function read<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(502, "MARKET_DATA_INVALID", "游戏市场返回的数据无法核对，已停止本次操作。");
  return parsed.data;
}
export type GoldTransferView = Pick<GoldTransfer, "id" | "status" | "expiresAt" | "createdAt" | "updatedAt" | "preview" | "message" | "orderId" | "settlement">;
function view(operation: GoldTransfer): GoldTransferView {
  const { id, status, expiresAt, createdAt, updatedAt, preview, message, orderId, settlement } = operation;
  return { id, status, expiresAt, createdAt, updatedAt, preview, message, orderId, settlement };
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作异常";

export class GoldTransferService {
  private deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos };
  private previews: TradePreviewService;
  private checking = new Set<string>();

  constructor(deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos }) {
    this.deps = deps;
    this.previews = new TradePreviewService(deps);
    deps.repos.goldTransfers.recoverInterrupted();
  }
  prepare(userId: string, preview: TradePreview): { id: string; expiresAt: number } | undefined {
    if (preview.issues.length || !preview.candidate) return undefined;
    const operation = this.deps.repos.goldTransfers.create(userId, preview);
    return { id: operation.id, expiresAt: operation.expiresAt };
  }
  get(userId: string, id: string): GoldTransferView { return view(this.owned(userId, id)); }
  recent(userId: string): GoldTransferView[] { return this.deps.repos.goldTransfers.recent(userId).map(view); }

  confirm(userId: string, id: string): GoldTransferView {
    const { operation, started } = this.deps.repos.goldTransfers.claim(userId, id);
    if (started) {
      // 持久化认领先于游戏请求；同一记录再次确认只返回状态。
      try {
        this.deps.repos.audit.record({ userId, action: AUDIT_ACTIONS.GOLD_TRANSFER_CONFIRMED, target: id,
          detail: { payer: operation.preview.payer.accountId, receiver: operation.preview.receiver.accountId, grossGold: operation.preview.grossGold } });
      } catch (error) {
        this.deps.repos.goldTransfers.update(userId, id, "failed", { message: "确认记录保存失败，尚未发起交易。" });
        throw error;
      }
      void this.execute(userId, operation);
    }
    return this.get(userId, id);
  }

  async check(userId: string, id: string): Promise<GoldTransferView> {
    const operation = this.owned(userId, id);
    if (operation.status !== "review_required" || this.checking.has(id)) return view(operation);
    this.checking.add(id);
    try {
      const clients = this.clients(userId, operation);
      await this.checkIdentities(operation, clients);
      await this.verify(userId, operation, clients);
    } catch (error) {
      this.deps.repos.goldTransfers.update(userId, id, "review_required", { message: `核对尚未完成：${messageOf(error)}。请在游戏内检查成交记录和挂单。` });
    } finally { this.checking.delete(id); }
    return this.get(userId, id);
  }
  close(userId: string, id: string): GoldTransferView {
    const operation = this.owned(userId, id);
    if (operation.status !== "review_required" || this.checking.has(id)) throw new HttpError(409, "TRANSFER_NOT_CLOSABLE", "只能结束已核对的异常记录，请等待当前操作完成。");
    this.deps.repos.audit.record({ userId, action: AUDIT_ACTIONS.GOLD_TRANSFER_CLOSED, target: id });
    return view(this.deps.repos.goldTransfers.update(userId, id, "closed", {
      message: "用户已确认在游戏内核对并结束记录；此操作未退款、撤单或再次交易。",
    }));
  }
  private owned(userId: string, id: string): GoldTransfer {
    const operation = this.deps.repos.goldTransfers.find(userId, id);
    if (!operation) throw new HttpError(404, "TRANSFER_NOT_FOUND", "交易记录不存在。");
    return operation;
  }
  private clients(userId: string, operation: GoldTransfer) {
    const { payer, receiver, baseUrl } = operation.preview;
    for (const account of [payer, receiver]) {
      const current = this.deps.accounts.getForUser(account.accountId, userId);
      if (current.baseUrl !== baseUrl) throw new HttpError(409, "ACCOUNT_CHANGED", "账号服务器地址已变化，请重新预览。");
    }
    return { payer: this.deps.registry.require(payer.accountId).client, receiver: this.deps.registry.require(receiver.accountId).client };
  }
  private approved(userId: string): void {
    if (this.deps.repos.users.findById(userId)?.status !== "approved") throw new HttpError(403, "NOT_APPROVED", "用户状态已变化，操作已停止。");
  }
  private async checkIdentities(operation: GoldTransfer, clients: { payer: GameClient; receiver: GameClient }) {
    const [payer, receiver] = await Promise.all([clients.payer.me(), clients.receiver.me()]);
    if (read(profileSchema, payer).player.id !== operation.preview.payer.playerId
      || read(profileSchema, receiver).player.id !== operation.preview.receiver.playerId) {
      throw new HttpError(409, "ACCOUNT_CHANGED", "游戏登录角色已变化，操作已停止。");
    }
  }
  private async execute(userId: string, original: GoldTransfer): Promise<void> {
    let wrote = false;
    const id = original.id;
    try {
      const plan = original.preview;
      const fresh = await this.previews.preview(userId, { payerAccountId: plan.payer.accountId, receiverAccountId: plan.receiver.accountId,
        amount: plan.requestedGold }, plan.candidate!.id);
      if (fresh.issues.length || fresh.baseUrl !== plan.baseUrl || fresh.payer.playerId !== plan.payer.playerId
        || fresh.receiver.playerId !== plan.receiver.playerId || fresh.grossGold !== plan.grossGold
        || fresh.feeGold !== plan.feeGold || fresh.netGold !== plan.netGold || fresh.feeBasisPoints !== plan.feeBasisPoints
        || JSON.stringify(fresh.candidate) !== JSON.stringify(plan.candidate)) {
        throw new HttpError(409, "PREVIEW_CHANGED", "账号、税率、余额条件或装备已变化，请重新生成预览。");
      }
      const clients = this.clients(userId, original);
      const [payerTrades, receiverTrades] = await Promise.all([clients.payer.marketGearTrades(), clients.receiver.marketGearTrades()]);
      this.deps.repos.goldTransfers.update(userId, id, "executing", {
        baseline: { payer: read(tradesSchema, payerTrades).trades.map((trade) => trade.id), receiver: read(tradesSchema, receiverTrades).trades.map((trade) => trade.id) },
        message: "正在上架已确认的装备。",
      });
      await this.checkIdentities(original, clients);
      this.clients(userId, original);
      this.approved(userId);
      wrote = true;
      const listed = await clients.receiver.marketGearOrder(plan.candidate!.id, plan.grossGold, original.listingKey);
      const orderId = read(z.object({ order: z.object({ id: z.string().min(1) }) }), listed).order.id;
      this.deps.repos.goldTransfers.update(userId, id, "executing", { orderId, message: "正在核对本次挂单。" });
      let cursor: string | undefined;
      let found = false;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const orders = read(ordersSchema, await clients.receiver.marketOwnGearOrders(cursor));
        const order = orders.orders.find((item) => item.id === orderId);
        if (order) {
          if (order.status !== "active" || order.asset.gear.id !== plan.candidate!.id || order.limitUnitPrice !== plan.grossGold) {
            throw new Error("挂单的装备、价格或状态与确认内容不一致，未购买。");
          }
          found = true; break;
        }
        cursor = orders.nextCursor ?? undefined;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      if (!found) throw new Error("未能在收款账号的有效挂单中核对本次订单，未购买。");
      await this.checkIdentities(original, clients);
      if (read(feeSchema, await clients.receiver.marketConfig()).sellerFeeBasisPoints !== plan.feeBasisPoints) throw new Error("税率已变化，未购买。");
      this.clients(userId, original);
      this.approved(userId);
      this.deps.repos.goldTransfers.update(userId, id, "executing", { message: "正在由付款账号购买指定订单。" });
      await clients.payer.marketPurchase(orderId, original.purchaseKey);
      this.deps.repos.goldTransfers.update(userId, id, "executing", { message: "正在核对双方实际成交记录。" });
      await this.verify(userId, this.owned(userId, id), clients);
    } catch (error) {
      this.deps.repos.goldTransfers.update(userId, id, wrote ? "review_required" : "failed", {
        message: wrote ? `结果待核对：${messageOf(error)}。不会自动重试；请核对记录，并在游戏内取消仍未成交的挂单。`
          : `尚未发起交易：${messageOf(error)}`,
      });
    }
  }
  private async verify(userId: string, operation: GoldTransfer, clients: { payer: GameClient; receiver: GameClient }): Promise<void> {
    if (!operation.baseline || !operation.orderId) throw new Error("缺少完整订单或交易前记录，需要在游戏内人工核对");
    const [payerRaw, receiverRaw] = await Promise.all([clients.payer.marketGearTrades(), clients.receiver.marketGearTrades()]);
    const payer = read(tradesSchema, payerRaw).trades;
    const receiver = read(tradesSchema, receiverRaw).trades;
    const plan = operation.preview;
    const buys = payer.filter((trade) => trade.role === "buyer" && trade.asset.gear.id === plan.candidate!.id
      && !operation.baseline!.payer.includes(trade.id));
    const matches = receiver.filter((trade) => trade.role === "seller" && trade.asset.gear.id === plan.candidate!.id
      && !operation.baseline!.receiver.includes(trade.id) && buys.some((buy) => buy.id === trade.id && buy.gross === trade.gross && buy.quantity === trade.quantity));
    const trade = matches.length === 1 ? matches[0] : undefined;
    if (!trade || trade.quantity !== 1 || trade.fee == null || trade.sellerProceeds == null) throw new Error("未能将双方记录核对为同一笔装备成交");
    const settlement: GoldSettlement = { tradeId: trade.id, grossGold: trade.gross, feeGold: trade.fee, netGold: trade.sellerProceeds };
    if (trade.gross !== plan.grossGold || trade.fee !== plan.feeGold || trade.sellerProceeds !== plan.netGold) {
      this.deps.repos.goldTransfers.update(userId, operation.id, "review_required", { settlement,
        message: "已查到双方成交，但实际金额与预览不同；请核对实际支付、手续费和到账金额，不要重复交易。" });
      return;
    }
    this.deps.repos.goldTransfers.update(userId, operation.id, "completed", { settlement, message: "交易完成，双方成交记录和实际到账金额均已核对。" });
  }
}
