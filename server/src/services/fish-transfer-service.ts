// 公开市场配对尝试：固定鱼种、价格和数量，先买后卖；不将价格数量视作订单身份。
import { z } from "zod";
import { HttpError } from "../api/server.ts";
import type { Repos } from "../db/repositories/index.ts";
import type { FishTransfer, FishSettlement } from "../db/repositories/fish-transfers.ts";
import type { AccountService } from "./account-service.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { GameClient } from "../game/client.ts";
import { masteryProfileSchema, readMasterySnapshot } from "./mastery-transfer-preview.ts";
import { MasterySupplyService, marketRead, checkFishBook, fishMarketConfigSchema, type FishTradeQuote } from "./mastery-supply-service.ts";
import { AUDIT_ACTIONS } from "../db/repositories/audit.ts";

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = amount.positive();
const asset = z.object({ type: z.literal("fish"), fish: z.object({ fishId: z.string().min(1) }) });
const orderSchema = z.object({ id: z.string().min(1), side: z.enum(["buy", "sell"]), status: z.string(), asset,
  limitUnitPrice: positive, initialQuantity: positive, remainingQuantity: amount, grossFilled: amount, feeCharged: amount });
const ordersSchema = z.object({ orders: z.array(orderSchema), nextCursor: z.string().min(1).nullish() });
const tradesSchema = z.object({ trades: z.array(z.object({ id: z.string().min(1), role: z.enum(["buyer", "seller"]), asset,
  quantity: positive, unitPrice: positive, gross: amount, fee: amount.nullish(), sellerProceeds: amount.nullish() })) });
const orderIdSchema = z.object({ order: z.object({ id: z.string().min(1) }) });
export type FishTransferView = Pick<FishTransfer, "id" | "status" | "expiresAt" | "createdAt" | "updatedAt" | "quote" | "message" | "buyerOrderId" | "sellerOrderId" | "settlement">;
function view(operation: FishTransfer): FishTransferView {
  const { id, status, expiresAt, createdAt, updatedAt, quote, message, buyerOrderId, sellerOrderId, settlement } = operation;
  return { id, status, expiresAt, createdAt, updatedAt, quote, message, buyerOrderId, sellerOrderId, settlement };
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "未知错误";

export class FishTransferService {
  private deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos };
  private previews: MasterySupplyService;
  private checking = new Set<string>();
  constructor(deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos }) {
    this.deps = deps;
    this.previews = new MasterySupplyService(deps);
    deps.repos.fishTransfers.recoverInterrupted();
  }
  prepare(userId: string, quote: FishTradeQuote) {
    if (quote.issues.length) return undefined;
    const operation = this.deps.repos.fishTransfers.create(userId, quote);
    return { id: operation.id, expiresAt: operation.expiresAt };
  }
  private owned(userId: string, id: string): FishTransfer {
    const operation = this.deps.repos.fishTransfers.find(userId, id);
    if (!operation) throw new HttpError(404, "FISH_TRANSFER_NOT_FOUND", "专精鱼交易记录不存在。");
    return operation;
  }
  get(userId: string, id: string) { return view(this.owned(userId, id)); }
  recent(userId: string) { return this.deps.repos.fishTransfers.recent(userId).map(view); }
  confirm(userId: string, id: string) {
    const { operation, started } = this.deps.repos.fishTransfers.claim(userId, id);
    if (started) {
      try {
        this.deps.repos.audit.record({ userId, action: AUDIT_ACTIONS.FISH_TRANSFER_CONFIRMED, target: id,
          detail: { buyer: operation.quote.target.accountId, seller: operation.quote.source.accountId, fishId: operation.quote.fish.id, quantity: operation.quote.quantity, unitPrice: operation.quote.unitPrice } });
      } catch (error) {
        this.deps.repos.fishTransfers.update(userId, id, "failed", { message: "确认记录保存失败，尚未挂单。" });
        throw error;
      }
      void this.execute(userId, operation);
    }
    return this.get(userId, id);
  }
  private clients(userId: string, operation: FishTransfer) {
    if (this.deps.repos.users.findById(userId)?.status !== "approved") throw new HttpError(403, "NOT_APPROVED", "用户状态已变化，已停止。");
    for (const actor of [operation.quote.target, operation.quote.source]) {
      if (this.deps.accounts.getForUser(actor.accountId, userId).baseUrl !== operation.quote.baseUrl) throw new HttpError(409, "ACCOUNT_CHANGED", "账号游戏服务器已变化。");
    }
    return { buyer: this.deps.registry.require(operation.quote.target.accountId).client, seller: this.deps.registry.require(operation.quote.source.accountId).client };
  }
  private async identities(operation: FishTransfer, clients: { buyer: GameClient; seller: GameClient }) {
    const raw = await Promise.all([clients.buyer.me(), clients.seller.me()]);
    const players = raw.map((data) => marketRead(masteryProfileSchema, data).player);
    if (players[0]!.id !== operation.quote.target.playerId || players[1]!.id !== operation.quote.source.playerId
      || players.some((player) => !player.canAccessMarket)) throw new HttpError(409, "ACCOUNT_CHANGED", "账号角色或市场权限已变化，已停止。");
  }
  private async findOrder(client: GameClient, id: string, quote: FishTradeQuote, side: "buy" | "sell") {
    let cursor: string | undefined; const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const data = marketRead(ordersSchema, await client.marketOwnFishOrders(cursor));
      const order = data.orders.find((entry) => entry.id === id);
      if (order) {
        if (order.side !== side || order.asset.fish.fishId !== quote.fish.id || order.limitUnitPrice !== quote.unitPrice || order.initialQuantity !== quote.quantity) throw new Error("本次订单的鱼种、方向、价格或数量不一致。");
        return order;
      }
      cursor = data.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new Error("未在账号订单记录中找到本次订单，请到游戏内核对。");
  }
  private async execute(userId: string, original: FishTransfer): Promise<void> {
    const id = original.id; const plan = original.quote; let wrote = false;
    try {
      const fresh = await this.previews.quote(userId, { targetAccountId: plan.target.accountId, sourceAccountId: plan.source.accountId,
        biomeId: plan.fish.biomeId, fishId: plan.fish.id, quantity: plan.quantity, unitPrice: plan.unitPrice });
      if (fresh.issues.length || fresh.baseUrl !== plan.baseUrl || fresh.target.playerId !== plan.target.playerId || fresh.source.playerId !== plan.source.playerId
        || fresh.feeBasisPoints !== plan.feeBasisPoints || fresh.grossGold !== plan.grossGold) throw new Error(`预览条件已变化：${fresh.issues.join("；") || "账号或手续费变化"}。请重新预览。`);
      const clients = this.clients(userId, original);
      const raw = await Promise.all([clients.buyer.marketFishTrades(), clients.seller.marketFishTrades()]);
      this.deps.repos.fishTransfers.update(userId, id, "executing", { baseline: {
        buyer: marketRead(tradesSchema, raw[0]).trades.map((trade) => trade.id), seller: marketRead(tradesSchema, raw[1]).trades.map((trade) => trade.id),
      }, message: "正在由需求账号挂买单。" });
      await this.identities(original, clients);
      checkFishBook(await clients.buyer.marketFishOrderBook(plan.fish.id), plan.unitPrice);
      this.clients(userId, original);
      wrote = true;
      const buyResult = await clients.buyer.marketFishOrder("buy", plan.fish.id, plan.quantity, plan.unitPrice, original.buyKey);
      const buyerOrderId = marketRead(orderIdSchema, buyResult).order.id;
      this.deps.repos.fishTransfers.update(userId, id, "executing", { buyerOrderId, message: "买单已挂，正在再次核对盘口和可出售余量。" });
      const [buyerMastery, buyerInventory, sellerMastery, sellerInventory, buyerConfigRaw, sellerConfigRaw] = await Promise.all([
        clients.buyer.mastery(), clients.buyer.inventoryFish(), clients.seller.mastery(), clients.seller.inventoryFish(), clients.buyer.marketConfig(), clients.seller.marketConfig(),
      ]);
      const need = readMasterySnapshot(buyerMastery, buyerInventory).missing.get(plan.fish.id) ?? 0;
      const spare = readMasterySnapshot(sellerMastery, sellerInventory).stocks.get(plan.fish.id)?.spare ?? 0;
      if (need < plan.quantity || spare < plan.quantity) throw new Error("挂买单后专精缺口或供给余量变化，未继续卖出。");
      const buyerConfig = marketRead(fishMarketConfigSchema, buyerConfigRaw);
      const sellerConfig = marketRead(fishMarketConfigSchema, sellerConfigRaw);
      if (sellerConfig.sellerFeeBasisPoints !== plan.feeBasisPoints || sellerConfig.activeOrderCount >= sellerConfig.maxActiveOrdersPerPlayer
        || Math.min(buyerConfig.maxFishOrderQuantity, sellerConfig.maxFishOrderQuantity) < plan.quantity) throw new Error("挂买单后市场条件变化，未继续卖出。");
      for (const config of [buyerConfig, sellerConfig]) {
        const floor = config.fishMinimumPrices.find((entry) => entry.biomeId === plan.fish.biomeId && entry.rarity === plan.fish.rarity);
        if (Math.max(plan.fish.sellPrice, floor?.configuredMinimumUnitPrice ?? plan.fish.sellPrice) > plan.unitPrice) throw new Error("市场最低单价变化，未继续卖出。");
      }
      const buy = await this.findOrder(clients.buyer, buyerOrderId, plan, "buy");
      if (buy.status !== "active" || buy.remainingQuantity !== plan.quantity || buy.grossFilled !== 0) throw new Error("买单已被成交、部分成交或状态改变，未继续卖出。");
      await this.identities(original, clients);
      checkFishBook(await clients.buyer.marketFishOrderBook(plan.fish.id), plan.unitPrice, plan.quantity);
      this.clients(userId, original);
      this.deps.repos.fishTransfers.update(userId, id, "executing", { message: "正在由选定供给账号按确认价格卖出。" });
      const sellResult = await clients.seller.marketFishOrder("sell", plan.fish.id, plan.quantity, plan.unitPrice, original.sellKey);
      const sellerOrderId = marketRead(orderIdSchema, sellResult).order.id;
      this.deps.repos.fishTransfers.update(userId, id, "executing", { sellerOrderId, message: "正在核对双方订单及实际成交记录。" });
      await this.verify(userId, this.owned(userId, id), clients);
    } catch (error) {
      this.deps.repos.fishTransfers.update(userId, id, wrote ? "review_required" : "failed", {
        message: wrote ? `需要核对：${messageOf(error)} 不会自动重试或补买、补卖。请到游戏内核对双方记录并取消仍未成交的本次挂单。`
          : `尚未挂单：${messageOf(error)}`,
      });
    }
  }
  async check(userId: string, id: string) {
    const operation = this.owned(userId, id);
    if (operation.status !== "review_required" || this.checking.has(id)) return view(operation);
    this.checking.add(id);
    try {
      const clients = this.clients(userId, operation);
      await this.identities(operation, clients);
      await this.verify(userId, operation, clients);
    } catch (error) {
      this.deps.repos.fishTransfers.update(userId, id, "review_required", { message: `尚未核对完成：${messageOf(error)} 请在游戏内检查成交并取消剩余挂单，不要重复交易。` });
    } finally { this.checking.delete(id); }
    return this.get(userId, id);
  }
  close(userId: string, id: string) {
    const operation = this.owned(userId, id);
    if (operation.status !== "review_required" || this.checking.has(id)) throw new HttpError(409, "FISH_TRANSFER_NOT_CLOSABLE", "只能在核对异常记录后结束，请先等待当前操作完成。");
    this.deps.repos.audit.record({ userId, action: AUDIT_ACTIONS.FISH_TRANSFER_CLOSED, target: id });
    return view(this.deps.repos.fishTransfers.update(userId, id, "closed", { message: "用户已确认在游戏内核对并处理剩余挂单。结束记录未退款、撤单或再次交易。" }));
  }
  private async verify(userId: string, operation: FishTransfer, clients: { buyer: GameClient; seller: GameClient }) {
    const plan = operation.quote;
    if (!operation.baseline || !operation.buyerOrderId || !operation.sellerOrderId) throw new Error("缺少完整订单编号或交易前记录，需要人工核对。");
    const [buyOrder, sellOrder, buyerRaw, sellerRaw] = await Promise.all([
      this.findOrder(clients.buyer, operation.buyerOrderId, plan, "buy"), this.findOrder(clients.seller, operation.sellerOrderId, plan, "sell"),
      clients.buyer.marketFishTrades(), clients.seller.marketFishTrades(),
    ]);
    const buyer = marketRead(tradesSchema, buyerRaw).trades.filter((trade) => trade.asset.fish.fishId === plan.fish.id && trade.role === "buyer" && !operation.baseline!.buyer.includes(trade.id));
    const seller = marketRead(tradesSchema, sellerRaw).trades.filter((trade) => trade.asset.fish.fishId === plan.fish.id && trade.role === "seller" && !operation.baseline!.seller.includes(trade.id));
    if (new Set(buyer.map((trade) => trade.id)).size !== buyer.length || new Set(seller.map((trade) => trade.id)).size !== seller.length) throw new Error("成交记录含重复编号，不能可靠核对。");
    const matched = seller.filter((trade) => buyer.some((buy) => buy.id === trade.id && buy.quantity === trade.quantity && buy.gross === trade.gross && buy.unitPrice === trade.unitPrice));
    if (!matched.length || matched.length !== buyer.length || matched.length !== seller.length) throw new Error("双方新成交记录不能对应，可能尚未成交、部分成交或被第三方成交。");
    let quantity = 0n; let gross = 0n; let fee = 0n;
    for (const trade of matched) {
      const expectedFee = Number(BigInt(trade.gross) * BigInt(plan.feeBasisPoints) / 10000n);
      if (trade.unitPrice !== plan.unitPrice || BigInt(trade.gross) !== BigInt(trade.quantity) * BigInt(plan.unitPrice)
        || trade.fee !== expectedFee || trade.sellerProceeds !== trade.gross - expectedFee) throw new Error("实际成交单价、手续费或实收金额与确认条件不符。");
      quantity += BigInt(trade.quantity); gross += BigInt(trade.gross); fee += BigInt(trade.fee);
    }
    if (quantity !== BigInt(plan.quantity) || gross !== BigInt(plan.grossGold)
      || [buyOrder, sellOrder].some((order) => order.status !== "filled" || order.remainingQuantity !== 0 || order.grossFilled !== plan.grossGold)
      || BigInt(sellOrder.feeCharged) !== fee) throw new Error("双方数量或订单结算尚未完整核对，不能报告交易完成。");
    const settlement: FishSettlement = { quantity: Number(quantity), grossGold: Number(gross), feeGold: Number(fee), netGold: Number(gross - fee), tradeIds: matched.map((trade) => trade.id) };
    this.deps.repos.fishTransfers.update(userId, operation.id, "completed", { settlement, message: "双方订单及同一组成交记录已核对，所选鱼种、数量和实际金币结算均一致。" });
  }
}
