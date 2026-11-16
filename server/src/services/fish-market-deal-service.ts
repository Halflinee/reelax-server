// 单账号低买高卖：买入与挂卖分别手动确认，核对只读取自己的确定订单编号。
import { z } from "zod";
import { HttpError } from "../api/server.ts";
import type { AccountService } from "./account-service.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { GameClient } from "../game/client.ts";
import type { Repos } from "../db/repositories/index.ts";
import type { FishMarketDeal, FishMarketPlan } from "../db/repositories/fish-market-deals.ts";
import { AUDIT_ACTIONS } from "../db/repositories/audit.ts";
import { masteryProfileSchema, readMasterySnapshot } from "./mastery-transfer-preview.ts";
import { MasterySupplyService, marketRead, fishMarketConfigSchema, checkFishBook } from "./mastery-supply-service.ts";
import { rarityLabel } from "../modules/shared/rarity.ts";

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = amount.positive();
const orderSchema = z.object({ id: z.string().min(1), side: z.enum(["buy", "sell"]), status: z.string(),
  asset: z.object({ type: z.literal("fish"), fish: z.object({ fishId: z.string().min(1) }) }),
  limitUnitPrice: positive, initialQuantity: positive, remainingQuantity: amount, grossFilled: amount, feeCharged: amount });
const ordersSchema = z.object({ orders: z.array(orderSchema), nextCursor: z.string().min(1).nullish() });
const responseSchema = z.object({ order: z.object({ id: z.string().min(1) }) });
export type FishMarketDealView = Omit<FishMarketDeal, "buyKey" | "sellKey" | "stockBefore">;
function view(deal: FishMarketDeal): FishMarketDealView {
  const { buyKey: _buyKey, sellKey: _sellKey, stockBefore: _stock, ...result } = deal;
  return result;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "未知错误";
function safe(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(400, "AMOUNT_TOO_LARGE", "总金额超过可精确计算范围，请减少数量。");
  return Number(value);
}
const feeFor = (price: number, quantity: number, rate: number) => ((BigInt(price) * BigInt(rate) + 9999n) / 10000n) * BigInt(quantity);
function validateConfig(plan: FishMarketPlan, raw: unknown) {
  const config = marketRead(fishMarketConfigSchema, raw);
  const floor = config.fishMinimumPrices.find((entry) => entry.biomeId === plan.fish.biomeId && entry.rarity === plan.fish.rarity);
  const minimum = Math.max(1, plan.fish.sellPrice, floor?.configuredMinimumUnitPrice ?? plan.fish.sellPrice);
  if (config.sellerFeeBasisPoints !== plan.feeBasisPoints || config.maxFishOrderQuantity < plan.quantity
    || minimum > plan.buyPrice || minimum > plan.sellPrice || config.activeOrderCount >= config.maxActiveOrdersPerPlayer) {
    throw new HttpError(409, "MARKET_CONDITIONS_CHANGED", "手续费、底价、数量限制或挂单额度已变化，尚未提交本次订单。请核对后重试或到游戏内处理。");
  }
}

export class FishMarketDealService {
  private deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos };
  private catalog: MasterySupplyService;
  private checking = new Set<string>();
  constructor(deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos }) {
    this.deps = deps; this.catalog = new MasterySupplyService(deps); deps.repos.fishMarketDeals.recoverInterrupted();
  }
  private owned(userId: string, id: string) {
    const operation = this.deps.repos.fishMarketDeals.find(userId, id);
    if (!operation) throw new HttpError(404, "MARKET_DEAL_NOT_FOUND", "市场买卖记录不存在。");
    return operation;
  }
  recent(userId: string) { return this.deps.repos.fishMarketDeals.recent(userId).map(view); }
  get(userId: string, id: string) { return view(this.owned(userId, id)); }
  private client(userId: string, plan: FishMarketPlan) {
    if (this.deps.repos.users.findById(userId)?.status !== "approved") throw new HttpError(403, "NOT_APPROVED", "用户审批状态已变化，已停止。");
    const account = this.deps.accounts.getForUser(plan.account.accountId, userId);
    if (account.baseUrl !== plan.baseUrl) throw new HttpError(409, "ACCOUNT_CHANGED", "账号所属游戏服务器已变化，已停止。");
    return this.deps.registry.require(account.id).client;
  }
  private async identity(userId: string, plan: FishMarketPlan, client: GameClient) {
    this.client(userId, plan);
    const player = marketRead(masteryProfileSchema, await client.me()).player;
    if (player.id !== plan.account.playerId || !player.canAccessMarket) throw new HttpError(409, "ACCOUNT_CHANGED", "当前登录角色或市场权限已变化，已停止。");
    if (player.gold === undefined) throw new HttpError(502, "GAME_DATA_INVALID", "账号金币数据缺失。");
    return player;
  }
  async prepare(userId: string, input: { accountId: string; fishId: string; quantity: number; buyPrice: number; sellPrice: number }) {
    const account = this.deps.accounts.getForUser(input.accountId, userId);
    const catalog = await this.catalog.marketCatalog(userId, account.id);
    const fish = catalog.fish.find((entry) => entry.id === input.fishId);
    const biome = catalog.biomes.find((entry) => entry.id === fish?.biomeId);
    if (!fish || !biome) throw new HttpError(400, "UNKNOWN_FISH", "所选鱼种或地图不在本地固定资料中。");
    if (input.sellPrice <= input.buyPrice) throw new HttpError(400, "NO_MARKET_PROFIT", "卖出价必须高于买入价。");
    const client = this.deps.registry.require(account.id).client;
    const [profile, configRaw, book] = await Promise.all([client.me(), client.marketConfig(), client.marketFishOrderBook(fish.id)]);
    const player = marketRead(masteryProfileSchema, profile).player; const config = marketRead(fishMarketConfigSchema, configRaw);
    if (!player.canAccessMarket || player.gold === undefined) throw new HttpError(400, "MARKET_UNAVAILABLE", "账号尚不能使用市场或金币数据缺失。");
    const cost = BigInt(input.quantity) * BigInt(input.buyPrice); const fee = feeFor(input.sellPrice, input.quantity, config.sellerFeeBasisPoints);
    const gain = BigInt(input.quantity) * BigInt(input.sellPrice) - fee - cost;
    if (gain <= 0n) throw new HttpError(409, "NO_MARKET_PROFIT", "按当前税率保守计算没有净利润，请重新扫描。");
    if (cost > BigInt(player.gold)) throw new HttpError(409, "INSUFFICIENT_GOLD", "当前金币不足以挂出所选数量的买单，不会自动减少数量。");
    const plan: FishMarketPlan = { createdAt: Date.now(), baseUrl: account.baseUrl,
      account: { accountId: account.id, playerId: player.id, label: account.label, nickname: player.nickname, gold: player.gold, canAccessMarket: true },
      fish: { ...fish, biomeName: biome.name, rarityLabel: rarityLabel(fish.rarity) }, quantity: input.quantity,
      buyPrice: input.buyPrice, sellPrice: input.sellPrice, maxCostGold: safe(cost), feeBasisPoints: config.sellerFeeBasisPoints,
      expectedFeeGold: safe(fee), expectedProfitGold: safe(gain) };
    validateConfig(plan, config); checkFishBook(book, plan.buyPrice); checkFishBook(book, plan.sellPrice);
    return view(this.deps.repos.fishMarketDeals.create(userId, plan));
  }
  confirm(userId: string, id: string, side: "buy" | "sell") {
    if (this.checking.has(id)) throw new HttpError(409, "MARKET_DEAL_BUSY", "正在核对该记录，请稍后操作。");
    const { operation, started } = this.deps.repos.fishMarketDeals.claim(userId, id, side);
    if (started) {
      try {
        this.deps.repos.audit.record({ userId, target: id, action: side === "buy" ? AUDIT_ACTIONS.FISH_MARKET_BUY_CONFIRMED : AUDIT_ACTIONS.FISH_MARKET_SELL_CONFIRMED,
          detail: { accountId: operation.plan.account.accountId, fishId: operation.plan.fish.id, quantity: operation.plan.quantity, unitPrice: side === "buy" ? operation.plan.buyPrice : operation.plan.sellPrice } });
      } catch (error) {
        this.deps.repos.fishMarketDeals.update(userId, id, side === "buy" ? "failed" : "bought", { message: "确认记录保存失败，未提交订单。" }); throw error;
      }
      void this.execute(userId, operation, side);
    }
    return this.get(userId, id);
  }
  private async execute(userId: string, operation: FishMarketDeal, side: "buy" | "sell") {
    const plan = operation.plan; let attempted = false;
    try {
      const client = this.client(userId, plan);
      const [player, configRaw, mastery, inventory] = await Promise.all([
        this.identity(userId, plan, client), client.marketConfig(), client.mastery(), client.inventoryFish(),
      ]);
      validateConfig(plan, configRaw);
      const snapshot = readMasterySnapshot(mastery, inventory); const stock = snapshot.stocks.get(plan.fish.id);
      if (side === "buy") {
        if (player.gold! < plan.maxCostGold) throw new Error("当前余额不足，未挂买单。");
        if ((snapshot.missing.get(plan.fish.id) ?? 0) > 0) throw new Error("账号仍需要该鱼用于专精，买入后可能被预留；请先完成需求或换账号。");
        const book = await client.marketFishOrderBook(plan.fish.id);
        checkFishBook(book, plan.buyPrice); checkFishBook(book, plan.sellPrice);
        this.deps.repos.fishMarketDeals.update(userId, operation.id, "buying", { stockBefore: { owned: stock?.owned ?? 0, spare: stock?.spare ?? 0 } });
      } else {
        if (!operation.buyOrderId || !operation.stockBefore) throw new Error("缺少买入订单或买入前库存，不能挂卖。");
        const order = await this.findOrder(client, operation, "buy"); this.validateBuyOrder(operation, order);
        if (order.status !== "filled" || order.remainingQuantity !== 0 || order.grossFilled !== operation.costGold || operation.boughtQuantity !== plan.quantity) throw new Error("买单尚未完全成交或实际支出变化，未挂卖单。");
        if ((stock?.owned ?? 0) < operation.stockBefore.owned + plan.quantity || (stock?.spare ?? 0) < operation.stockBefore.spare + plan.quantity) {
          throw new Error("本次买入后新增的可出售库存不足，可能被锁定、预留给专精或已被消耗；不会动用买入前的存量。");
        }
        const net = BigInt(plan.sellPrice) * BigInt(plan.quantity) - feeFor(plan.sellPrice, plan.quantity, plan.feeBasisPoints);
        if (net <= BigInt(operation.costGold)) throw new Error("按已保存卖价和实际成本计算已无净利润，未挂卖单。");
      }
      await this.identity(userId, plan, client); this.client(userId, plan);
      // 先持久记录即将发送的方向；丢失响应或重启后，不能将未知卖单误判为尚未挂卖。
      this.deps.repos.fishMarketDeals.update(userId, operation.id, side === "buy" ? "buying" : "selling", { pendingSide: side });
      attempted = true;
      const raw = await client.marketFishOrder(side, plan.fish.id, plan.quantity, side === "buy" ? plan.buyPrice : plan.sellPrice, side === "buy" ? operation.buyKey : operation.sellKey);
      const orderId = marketRead(responseSchema, raw).order.id;
      this.deps.repos.fishMarketDeals.update(userId, operation.id, side === "buy" ? "buying" : "selling", side === "buy" ? { buyOrderId: orderId, pendingSide: null } : { sellOrderId: orderId, pendingSide: null });
      await this.inspect(userId, this.owned(userId, operation.id), client);
    } catch (error) {
      this.deps.repos.fishMarketDeals.update(userId, operation.id, attempted ? "review_required" : side === "buy" ? "failed" : "bought", {
        message: attempted ? `订单结果需要核对：${messageOf(error)} 不会自动重试或补单；请先核对游戏内订单。`
          : `未提交${side === "buy" ? "买" : "卖"}单：${messageOf(error)}`,
      });
    }
  }
  private async findOrder(client: GameClient, operation: FishMarketDeal, side: "buy" | "sell") {
    const orderId = side === "buy" ? operation.buyOrderId : operation.sellOrderId;
    if (!orderId) throw new Error("缺少确定的订单编号，请到游戏内人工核对，不能按价格或数量猜测订单。");
    let cursor: string | undefined; const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const data = marketRead(ordersSchema, await client.marketOwnFishOrders(cursor));
      const order = data.orders.find((entry) => entry.id === orderId);
      if (order) {
        if (order.side !== side || order.asset.fish.fishId !== operation.plan.fish.id || order.initialQuantity !== operation.plan.quantity
          || order.limitUnitPrice !== (side === "buy" ? operation.plan.buyPrice : operation.plan.sellPrice) || order.remainingQuantity > order.initialQuantity) throw new Error("订单方向、鱼种、数量或委托价格不一致。");
        return order;
      }
      cursor = data.nextCursor ?? undefined; if (!cursor || seen.has(cursor)) break; seen.add(cursor);
    }
    throw new Error("在返回的订单记录中没有找到本次订单，请到游戏内核对。");
  }
  private validateBuyOrder(operation: FishMarketDeal, order: z.infer<typeof orderSchema>) {
    const filled = BigInt(order.initialQuantity - order.remainingQuantity);
    if (order.feeCharged !== 0 || BigInt(order.grossFilled) < filled || BigInt(order.grossFilled) > filled * BigInt(operation.plan.buyPrice)
      || (order.status === "filled" && order.remainingQuantity !== 0) || (order.status === "active" && order.remainingQuantity === 0)) throw new Error("买单的成交数量、实际支出或手续费无法可靠核对。");
  }
  private async inspect(userId: string, operation: FishMarketDeal, client: GameClient) {
    if (operation.pendingSide) throw new Error(`${operation.pendingSide === "buy" ? "买" : "卖"}单请求结果不明且未保存确定编号，需要在游戏内人工核对；不会再次发送该订单。`);
    const buy = await this.findOrder(client, operation, "buy"); this.validateBuyOrder(operation, buy);
    const boughtQuantity = buy.initialQuantity - buy.remainingQuantity;
    const progress = { boughtQuantity, costGold: buy.grossFilled };
    if (!operation.sellOrderId) {
      if (buy.status === "filled") this.deps.repos.fishMarketDeals.update(userId, operation.id, "bought", { ...progress, message: "买单已全部成交。请核对实际支出，再手动确认按预览价挂卖；尚未挂卖。" });
      else if (buy.status === "active") this.deps.repos.fishMarketDeals.update(userId, operation.id, "buy_open", { ...progress, message: boughtQuantity ? "买单部分成交，尚未买足，不会挂卖。可稍后再核对；如要取消请到游戏内处理。" : "买单已挂，正在等待其他玩家卖出。不会自动加价、补单或挂卖。" });
      else this.deps.repos.fishMarketDeals.update(userId, operation.id, "review_required", { ...progress, message: "买单已取消、过期或状态变化，未挂卖。请到游戏内核对部分买入及剩余订单后结束记录。" });
      return;
    }
    if (buy.status !== "filled" || buy.remainingQuantity !== 0 || buy.grossFilled !== operation.costGold || boughtQuantity !== operation.plan.quantity) throw new Error("已挂卖，但买入记录与先前核对的实际成本不一致。");
    const sell = await this.findOrder(client, operation, "sell"); const soldQuantity = sell.initialQuantity - sell.remainingQuantity;
    if (BigInt(sell.grossFilled) < BigInt(soldQuantity) * BigInt(operation.plan.sellPrice) || sell.feeCharged > sell.grossFilled || (soldQuantity === 0 && sell.grossFilled !== 0)
      || (sell.status === "filled" && sell.remainingQuantity !== 0) || (sell.status === "active" && sell.remainingQuantity === 0)) throw new Error("卖单实际收入、手续费或成交数量无法核对。");
    const proceeds = { ...progress, soldQuantity, grossGold: sell.grossFilled, feeGold: sell.feeCharged };
    if (sell.status === "filled") this.deps.repos.fishMarketDeals.update(userId, operation.id, "completed", { ...proceeds,
      profitGold: safe(BigInt(sell.grossFilled) - BigInt(sell.feeCharged) - BigInt(buy.grossFilled)), message: "买卖两笔订单均已全部成交，已按实际支出、卖出收入及手续费计算本笔净利润。" });
    else if (sell.status === "active") this.deps.repos.fishMarketDeals.update(userId, operation.id, "sell_open", { ...proceeds, message: "卖单已按预览价挂出，尚未全部成交。不会自动降价；稍后可只读核对成交状态。" });
    else this.deps.repos.fishMarketDeals.update(userId, operation.id, "review_required", { ...proceeds, message: "卖单已取消、过期或状态变化，请核对部分成交和剩余鱼获；本笔完整净利润尚未结算。" });
  }
  async check(userId: string, id: string) {
    const operation = this.owned(userId, id);
    if (!["buy_open", "bought", "sell_open", "review_required"].includes(operation.status) || this.checking.has(id)) return view(operation);
    this.checking.add(id);
    try { const client = this.client(userId, operation.plan); await this.identity(userId, operation.plan, client); await this.inspect(userId, operation, client); }
    catch (error) { this.deps.repos.fishMarketDeals.update(userId, id, "review_required", { message: `核对未完成：${messageOf(error)} 不会重新下单，请到游戏内核对。` }); }
    finally { this.checking.delete(id); }
    return this.get(userId, id);
  }
  close(userId: string, id: string) {
    const operation = this.owned(userId, id);
    if (!["buy_open", "bought", "sell_open", "review_required"].includes(operation.status) || this.checking.has(id)) throw new HttpError(409, "MARKET_DEAL_NOT_CLOSABLE", "当前记录不能结束，请先等待请求或核对完成。");
    this.deps.repos.audit.record({ userId, target: id, action: AUDIT_ACTIONS.FISH_MARKET_CLOSED });
    return view(this.deps.repos.fishMarketDeals.update(userId, id, "closed", { message: "用户已确认在游戏内核对并处理未成交订单和鱼获。结束记录没有撤单、退款或再次交易。" }));
  }
}
