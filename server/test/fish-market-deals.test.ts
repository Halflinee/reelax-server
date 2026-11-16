import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { FishMarketDealService, type FishMarketDealView } from "../src/services/fish-market-deal-service.ts";
import { GameClientError, GAME_ERROR_CODES } from "../src/game/errors.ts";
import type { FishTradeQuote } from "../src/services/mastery-supply-service.ts";
import type { TradePreview } from "../src/services/trade-preview-service.ts";
import { openDb } from "../src/db/client.ts";
import { createRepos } from "../src/db/repositories/index.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: FullApp; let seq = 0;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
type Order = { id: string; side: "buy" | "sell"; status: string; asset: { type: "fish"; fish: { fishId: string } };
  limitUnitPrice: number; initialQuantity: number; remainingQuantity: number; grossFilled: number; feeCharged: number };
function fixture() {
  const user = app.seedApprovedUser(`fish-deal-${++seq}@example.com`); const accountId = app.seedAccount(user.id, "买卖账号");
  const baseUrl = `https://deal-${seq}.example`; app.repos.accounts.update(accountId, user.id, { baseUrl });
  const calls: { path: string; method: string; key: unknown; body: { side?: string; quantity?: number; limitUnitPrice?: number } }[] = [];
  const state = { gold: 1000, stock: 10, locked: false, masteryNeed: 0, playerId: accountId, access: true, rate: 500, minPrice: 50,
    bid: 100, ask: 120, maxQuantity: 100, maxOrders: 10, loseBuy: false, loseSell: false, failOrders: false, omitOrder: false,
    orders: [] as Order[], afterBuy: () => {}, afterSell: () => {}, orderGate: Promise.resolve() };
  const input = { accountId, fishId: "fish", quantity: 3, buyPrice: 101, sellPrice: 119 };
  const path = "/api/mastery-transfer-preview/market-deals";
  vi.spyOn(app.registry.require(accountId).client, "request").mockImplementation(async (url, options) => {
    const method = options?.method ?? "GET"; const body = options?.body as { side: "buy" | "sell"; quantity: number; limitUnitPrice: number } | undefined;
    calls.push({ path: url, method, key: options?.headers?.["Idempotency-Key"], body: body ?? {} });
    if (url === "/api/content/bootstrap") return { biomes: [{ id: "map", name: "地图" }], fish: [{ id: "fish", name: "测试鱼", biomeId: "map", rarity: "common", sellPrice: 50 }] };
    if (url === "/api/me") return { player: { id: state.playerId, nickname: "角色", gold: state.gold, canAccessMarket: state.access } };
    if (url === "/api/market/config") return { sellerFeeBasisPoints: state.rate, maxFishOrderQuantity: state.maxQuantity,
      maxActiveOrdersPerPlayer: state.maxOrders, activeOrderCount: state.orders.filter((order) => order.status === "active").length,
      fishMinimumPrices: [{ biomeId: "map", rarity: "common", configuredMinimumUnitPrice: state.minPrice }] };
    if (url === "/api/mastery") return { biomes: state.masteryNeed ? [{ biomeId: "map", isUnlocked: true, rarities: [{ rarity: "common", fish: { id: "fish" }, remainingQuantity: state.masteryNeed, availableQuantity: 0 }] }] : [] };
    if (url === "/api/inventory/fish") return { fish: [{ fishId: "fish", quantity: state.stock, isLocked: state.locked }] };
    if (url === "/api/market/fish/fish/order-book?limit=50") return { version: 1, buyLevels: [{ unitPrice: state.bid, quantity: 10 }], sellLevels: [{ unitPrice: state.ask, quantity: 10 }] };
    if (url === "/api/market/me/orders?assetType=fish&limit=50") {
      await state.orderGate;
      if (state.failOrders) throw new GameClientError("订单读取超时", { code: GAME_ERROR_CODES.TIMEOUT });
      return { orders: state.omitOrder ? [] : structuredClone(state.orders) };
    }
    if (url === "/api/market/orders" && method === "POST" && body) {
      const order: Order = { id: `${body.side}-${seq}-${state.orders.length}`, side: body.side, status: "active", asset: { type: "fish", fish: { fishId: "fish" } },
        limitUnitPrice: body.limitUnitPrice, initialQuantity: body.quantity, remainingQuantity: body.quantity, grossFilled: 0, feeCharged: 0 };
      state.orders.push(order);
      if (body.side === "buy") { state.gold -= body.quantity * body.limitUnitPrice; state.afterBuy(); }
      else { state.stock -= body.quantity; state.afterSell(); }
      if ((body.side === "buy" && state.loseBuy) || (body.side === "sell" && state.loseSell)) throw new GameClientError("已提交但响应丢失", { code: GAME_ERROR_CODES.TIMEOUT });
      return { order: { id: order.id } };
    }
    throw new Error(`不应调用 ${method} ${url}`);
  });
  function fill(side: "buy" | "sell", quantity = 3, price = side === "buy" ? 101 : 119) {
    const order = state.orders.findLast((item) => item.side === side)!;
    order.remainingQuantity -= quantity; order.status = order.remainingQuantity ? "active" : "filled"; order.grossFilled += quantity * price;
    if (side === "buy") { state.stock += quantity; state.gold += (order.limitUnitPrice - price) * quantity; }
    else { const fee = Math.floor(quantity * price * state.rate / 10000); order.feeCharged += fee; state.gold += quantity * price - fee; }
  }
  const prepare = async (extra = {}) => {
    const response = await app.post<FishMarketDealView>(`${path}/preview`, { ...input, ...extra }, user.jar);
    expect(response.status).toBe(200); return response.body;
  };
  const action = (id: string, name: "buy" | "sell" | "check" | "close") => app.post<FishMarketDealView>(`${path}/${id}/${name}`,
    name === "check" ? {} : name === "close" ? { confirmed: true, handledInGame: true } : { confirmed: true, acceptPublicMatching: true }, user.jar);
  const settled = async (id: string) => {
    let result: FishMarketDealView | undefined;
    await vi.waitFor(async () => { result = (await app.get<FishMarketDealView>(`${path}/${id}`, user.jar)).body; expect(["buying", "selling"]).not.toContain(result.status); }, { timeout: 3000, interval: 10 });
    return result!;
  };
  const writes = () => calls.filter((call) => call.method !== "GET");
  const bought = async () => { const preview = await prepare(); await action(preview.id, "buy"); await settled(preview.id); fill("buy"); expect((await action(preview.id, "check")).body.status).toBe("bought"); return preview.id; };
  return { user, accountId, baseUrl, state, input, path, calls, prepare, action, settled, writes, fill, bought };
}

describe("分两次确认的市场买卖", () => {
  it("生成预览只读，显示固定价格、数量、最大本金和保守利润", async () => {
    const f = fixture(); const deal = await f.prepare();
    expect(deal).toMatchObject({ status: "previewed", plan: { quantity: 3, buyPrice: 101, sellPrice: 119, maxCostGold: 303, expectedFeeGold: 18, expectedProfitGold: 36 }, profitGold: null });
    expect(deal).not.toHaveProperty("buyKey"); expect(deal).not.toHaveProperty("stockBefore"); expect(f.writes()).toHaveLength(0);
  });
  it("第一步只挂一次买单；买足后核对不自动卖，再次确认才挂固定价格卖单", async () => {
    const f = fixture(); const deal = await f.prepare();
    await f.action(deal.id, "buy"); expect((await f.settled(deal.id)).status).toBe("buy_open"); expect(f.writes()).toHaveLength(1);
    f.fill("buy", 3, 100); const checked = await f.action(deal.id, "check");
    expect(checked.body).toMatchObject({ status: "bought", boughtQuantity: 3, costGold: 300, profitGold: null }); expect(f.writes()).toHaveLength(1);
    f.state.bid = 90; f.state.ask = 110;
    await f.action(deal.id, "sell"); expect((await f.settled(deal.id)).status).toBe("sell_open");
    expect(f.writes().map((call) => call.body)).toEqual([{ assetType: "fish", side: "buy", fishId: "fish", quantity: 3, limitUnitPrice: 101 }, { assetType: "fish", side: "sell", fishId: "fish", quantity: 3, limitUnitPrice: 119 }]);
    expect(f.writes()[0]!.key).not.toBe(f.writes()[1]!.key);
    f.fill("sell", 3, 120); const completed = await f.action(deal.id, "check");
    expect(completed.body).toMatchObject({ status: "completed", grossGold: 360, feeGold: 18, costGold: 300, profitGold: 42 }); expect(f.writes()).toHaveLength(2);
  });
  it("买单部分成交时保留实际数量和支出，点击卖出也不能提前挂卖", async () => {
    const f = fixture(); const deal = await f.prepare(); await f.action(deal.id, "buy"); await f.settled(deal.id);
    f.fill("buy", 1); expect((await f.action(deal.id, "check")).body).toMatchObject({ status: "buy_open", boughtQuantity: 1, costGold: 101, profitGold: null });
    await f.action(deal.id, "sell"); expect(f.writes()).toHaveLength(1);
    f.fill("buy", 2); expect((await f.action(deal.id, "check")).body.status).toBe("bought"); expect(f.writes()).toHaveLength(1);
  });
  it("卖单部分成交不报告完整已实现利润", async () => {
    const f = fixture(); const id = await f.bought(); await f.action(id, "sell"); await f.settled(id);
    f.fill("sell", 1); const result = (await f.action(id, "check")).body;
    expect(result).toMatchObject({ status: "sell_open", soldQuantity: 1, grossGold: 119, feeGold: 5, profitGold: null });
  });
  it("立即成交的买单也不会自动触发卖单，立即卖出以实际分笔税费结算", async () => {
    const f = fixture(); f.state.afterBuy = () => f.fill("buy");
    const preview = await f.prepare(); await f.action(preview.id, "buy"); expect((await f.settled(preview.id)).status).toBe("bought"); expect(f.writes()).toHaveLength(1);
    f.state.afterSell = () => { f.fill("sell", 1); f.fill("sell", 2); };
    await f.action(preview.id, "sell"); expect(await f.settled(preview.id)).toMatchObject({ status: "completed", grossGold: 357, feeGold: 16, profitGold: 38 });
  });
  it("重复及并发确认同一记录，每个方向都只写一次", async () => {
    const f = fixture(); const deal = await f.prepare();
    await Promise.all([f.action(deal.id, "buy"), f.action(deal.id, "buy"), f.action(deal.id, "buy")]); await f.settled(deal.id);
    f.fill("buy"); await f.action(deal.id, "check");
    await Promise.all([f.action(deal.id, "sell"), f.action(deal.id, "sell")]); await f.settled(deal.id);
    await f.action(deal.id, "buy"); await f.action(deal.id, "sell"); expect(f.writes().map((call) => call.body.side)).toEqual(["buy", "sell"]);
  });
});

describe("条件变化与结果不明", () => {
  it.each(["gold", "rate", "minPrice", "maxQuantity", "maxOrders", "playerId", "access", "bid", "masteryNeed"] as const)("确认买入前 %s 变化时不写订单", async (field) => {
    const f = fixture(); const deal = await f.prepare();
    Object.assign(f.state, { [field]: { gold: 1, rate: 600, minPrice: 110, maxQuantity: 2, maxOrders: 0, playerId: "other-role", access: false, bid: 105, masteryNeed: 20 }[field] });
    await f.action(deal.id, "buy"); expect((await f.settled(deal.id)).status).toBe("failed"); expect(f.writes()).toHaveLength(0);
  });
  it.each(["locked", "consumed", "mastery", "fee", "limit", "buyOrderChanged"])("挂卖前 %s 变化时保留已买记录，不卖原有存量", async (change) => {
    const f = fixture(); const id = await f.bought();
    if (change === "locked") f.state.locked = true;
    if (change === "consumed") f.state.stock--;
    if (change === "mastery") f.state.masteryNeed = 20;
    if (change === "fee") f.state.rate = 600;
    if (change === "limit") f.state.maxQuantity = 2;
    if (change === "buyOrderChanged") f.state.orders[0]!.grossFilled--;
    await f.action(id, "sell"); const result = await f.settled(id);
    expect(result.status).toBe("bought"); expect(result.message).toContain("未提交卖单"); expect(f.writes()).toHaveLength(1);
  });
  it.each(["buy", "sell"] as const)("%s 请求丢失响应后，核对与重试确认都不能重复下单", async (side) => {
    const f = fixture(); const id = side === "buy" ? (await f.prepare()).id : await f.bought();
    if (side === "buy") f.state.loseBuy = true; else f.state.loseSell = true;
    await f.action(id, side); expect((await f.settled(id)).status).toBe("review_required");
    const before = f.writes().length; expect((await f.action(id, "check")).body.status).toBe("review_required");
    await f.action(id, side); expect(f.writes()).toHaveLength(before);
    expect(app.repos.fishMarketDeals.find(f.user.id, id)?.pendingSide).toBe(side);
  });
  it("已取得编号但订单读取失败时，可只读恢复状态，不重新提交", async () => {
    const f = fixture(); const preview = await f.prepare(); f.state.failOrders = true;
    await f.action(preview.id, "buy"); expect((await f.settled(preview.id)).status).toBe("review_required");
    f.state.failOrders = false; expect((await f.action(preview.id, "check")).body.status).toBe("buy_open"); expect(f.writes()).toHaveLength(1);
  });
  it("买单被取消且仅部分成交，不会拿部分鱼自动挂卖", async () => {
    const f = fixture(); const preview = await f.prepare(); await f.action(preview.id, "buy"); await f.settled(preview.id); f.fill("buy", 1);
    f.state.orders[0]!.status = "cancelled";
    expect((await f.action(preview.id, "check")).body).toMatchObject({ status: "review_required", boughtQuantity: 1, costGold: 101 }); expect(f.writes()).toHaveLength(1);
  });
  it("订单字段损坏、编号不匹配不推断成交", async () => {
    const f = fixture(); const id = await f.bought(); f.state.orders[0]!.asset.fish.fishId = "wrong";
    expect((await f.action(id, "check")).body.status).toBe("review_required"); expect(f.writes()).toHaveLength(1);
  });
  it("核对进行中不能同时挂卖或解除交易占用", async () => {
    const f = fixture(); const id = await f.bought(); let release!: () => void;
    f.state.orderGate = new Promise((resolve) => { release = resolve; });
    const previousReads = f.calls.length; const checking = f.action(id, "check");
    await vi.waitFor(() => expect(f.calls.slice(previousReads).some((call) => call.path.includes("/me/orders?"))).toBe(true));
    try {
      expect((await f.action(id, "sell")).status).toBe(409);
      expect((await f.action(id, "close")).status).toBe(409); expect(f.writes()).toHaveLength(1);
    } finally { release(); }
    expect((await checking).body.status).toBe("bought");
  });
  it("卖单成交价或费用异常时不会报告盈利，恢复正确数据后可只读核对", async () => {
    const f = fixture(); const id = await f.bought(); await f.action(id, "sell"); await f.settled(id); f.fill("sell");
    const sell = f.state.orders.find((order) => order.side === "sell")!; sell.grossFilled = 1;
    expect((await f.action(id, "check")).body).toMatchObject({ status: "review_required", profitGold: null });
    sell.grossFilled = 357; expect((await f.action(id, "check")).body).toMatchObject({ status: "completed", profitGold: 37 }); expect(f.writes()).toHaveLength(2);
  });
  it("结束记录必须明确确认已在游戏内处理，不会自动撤单或退款", async () => {
    const f = fixture(); const preview = await f.prepare(); await f.action(preview.id, "buy"); await f.settled(preview.id);
    expect((await app.post(`${f.path}/${preview.id}/close`, { confirmed: true }, f.user.jar)).status).toBe(400);
    expect((await f.action(preview.id, "close")).body.status).toBe("closed"); expect(f.state.orders[0]!.status).toBe("active"); expect(f.writes()).toHaveLength(1);
  });
  it("重启只将执行中记录转待核对，等待成交和已买记录保留，不自动下单", async () => {
    const f = fixture(); const preview = await f.prepare(); app.repos.fishMarketDeals.claim(f.user.id, preview.id, "buy");
    app.repos.fishMarketDeals.update(f.user.id, preview.id, "buying", { pendingSide: "buy" });
    const service = new FishMarketDealService({ accounts: app.accounts, registry: app.registry, repos: app.repos });
    expect(service.get(f.user.id, preview.id).status).toBe("review_required"); expect(f.writes()).toHaveLength(0);
    const other = fixture(); const id = await other.bought();
    new FishMarketDealService({ accounts: app.accounts, registry: app.registry, repos: app.repos });
    expect(app.repos.fishMarketDeals.find(other.user.id, id)?.status).toBe("bought"); expect(other.writes()).toHaveLength(1);
  });
  it("磁盘数据库关闭再打开后，保留固定价格、幂等键和未知卖单标记", async () => {
    const f = fixture(); const preview = await f.prepare(); const file = path.join(os.tmpdir(), `reelax-deal-${randomUUID()}.db`);
    let db = openDb(file);
    try {
      db.migrate(); let repos = createRepos(db);
      const user = repos.users.create({ email: "persist@example.com", displayName: "测试", passwordHash: "placeholder", status: "approved" });
      const deal = repos.fishMarketDeals.create(user.id, preview.plan);
      repos.fishMarketDeals.update(user.id, deal.id, "selling", { buyOrderId: "known-buy", boughtQuantity: 3, costGold: 300, pendingSide: "sell" });
      db.close(); db = openDb(file); db.migrate(); repos = createRepos(db); repos.fishMarketDeals.recoverInterrupted();
      const recovered = repos.fishMarketDeals.find(user.id, deal.id)!;
      expect(recovered).toMatchObject({ status: "review_required", plan: { buyPrice: 101, sellPrice: 119, quantity: 3 }, buyOrderId: "known-buy", sellOrderId: null, pendingSide: "sell", costGold: 300 });
      expect(recovered.buyKey).toBe(deal.buyKey); expect(recovered.sellKey).toBe(deal.sellKey); expect(f.writes()).toHaveLength(0);
    } finally { db.close(); for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix); }
  });
  it("审计保存失败时不提交买单", async () => {
    const f = fixture(); const preview = await f.prepare(); vi.spyOn(app.repos.audit, "record").mockImplementationOnce(() => { throw new Error("审计保存失败"); });
    expect((await f.action(preview.id, "buy")).status).toBe(500);
    expect((await f.settled(preview.id)).status).toBe("failed"); expect(f.writes()).toHaveLength(0);
  });
});

describe("权限与账号交易占用", () => {
  it.each([{ quantity: 0 }, { quantity: 1.5 }, { buyPrice: "101" }, { sellPrice: -1 }, { autoSell: true }, { execute: true }])("拒绝参数绕过 %j", async (extra) => {
    const f = fixture(); expect((await app.post(`${f.path}/preview`, { ...f.input, ...extra }, f.user.jar)).status).toBe(400); expect(f.calls).toHaveLength(0);
  });
  it("未登录、未审批、越权记录及账号不能预览、确认、核对或关闭", async () => {
    const f = fixture(); const deal = await f.prepare(); const other = app.seedApprovedUser(`deal-other-${seq}@example.com`);
    expect((await app.post(`${f.path}/preview`, f.input)).status).toBe(401);
    expect((await app.post(`${f.path}/preview`, f.input, other.jar)).status).toBe(404);
    expect((await app.get(`${f.path}/${deal.id}`, other.jar)).status).toBe(404);
    for (const action of ["buy", "sell", "check", "close"]) {
      const body = action === "check" ? {} : action === "close" ? { confirmed: true, handledInGame: true } : { confirmed: true, acceptPublicMatching: true };
      expect((await app.post(`${f.path}/${deal.id}/${action}`, body, other.jar)).status).toBe(404);
    }
    app.repos.users.setStatus(f.user.id, "pending"); expect((await f.action(deal.id, "buy")).status).toBe(403); expect(f.writes()).toHaveLength(0);
  });
  it("缺少公开风险确认、篡改卖价数量和过期预览都不能发单", async () => {
    const f = fixture(); const deal = await f.prepare();
    expect((await app.post(`${f.path}/${deal.id}/buy`, { confirmed: true }, f.user.jar)).status).toBe(400);
    expect((await app.post(`${f.path}/${deal.id}/sell`, { confirmed: true, acceptPublicMatching: true, sellPrice: 999 }, f.user.jar)).status).toBe(400);
    app.db.run("UPDATE fish_market_deals SET expires_at=0 WHERE id=?", deal.id);
    expect((await f.action(deal.id, "buy")).status).toBe(409); expect(f.writes()).toHaveLength(0);
  });
  it.each([{ sellPrice: 102 }, { sellPrice: 100 }, { buyPrice: 100 }, { sellPrice: 120 }])("无利润或报价空档变化不能生成可执行预览 %j", async (extra) => {
    const f = fixture(); expect((await app.post(`${f.path}/preview`, { ...f.input, ...extra }, f.user.jar)).status).toBeGreaterThanOrEqual(400); expect(f.writes()).toHaveLength(0);
    expect(app.db.get<{ count: number }>("SELECT count(*) AS count FROM fish_market_deals WHERE user_id=?", f.user.id)?.count).toBe(0);
  });
  it("市场买单等待时阻止同角色的另一份预览、专精鱼调配和金币转移", async () => {
    const f = fixture(); const preview = await f.prepare(); const second = await f.prepare();
    await f.action(preview.id, "buy"); await f.settled(preview.id);
    expect((await f.action(second.id, "buy")).status).toBe(409);
    const plan = preview.plan; const quote: FishTradeQuote = { createdAt: Date.now(), baseUrl: plan.baseUrl, target: plan.account,
      source: { ...plan.account, accountId: "other", playerId: "other" }, fish: plan.fish, targetMissing: 3, sourceCanProvide: 3, quantity: 3, unitPrice: 101, grossGold: 303,
      feeBasisPoints: 500, feeGold: 15, netGold: 288, issues: [] };
    const fish = app.repos.fishTransfers.create(f.user.id, quote);
    expect(() => app.repos.fishTransfers.claim(f.user.id, fish.id)).toThrow("进行中");
    const gold: TradePreview = { createdAt: Date.now(), baseUrl: plan.baseUrl, payer: plan.account, receiver: quote.source, requestedGold: 1, grossGold: 1,
      feeGold: 0, netGold: 1, feeBasisPoints: 500, candidate: null, candidateCount: 0, scannedGearCount: 0, issues: [] };
    const transfer = app.repos.goldTransfers.create(f.user.id, gold);
    expect(() => app.repos.goldTransfers.claim(f.user.id, transfer.id)).toThrow("进行中");
    await f.action(preview.id, "close"); expect(app.repos.goldTransfers.claim(f.user.id, transfer.id).started).toBe(true);
    expect((await f.action(second.id, "buy")).status).toBe(409);
  });
  it("相同实际角色跨用户也占用；不同游戏服务器不互相占用", async () => {
    const f = fixture(); const preview = await f.prepare(); await f.action(preview.id, "buy"); await f.settled(preview.id);
    const other = app.seedApprovedUser(`same-role-${seq}@example.com`); const alias = app.seedAccount(other.id);
    const plan = { ...preview.plan, account: { ...preview.plan.account, accountId: alias } };
    const shared = app.repos.fishMarketDeals.create(other.id, plan);
    expect(() => app.repos.fishMarketDeals.claim(other.id, shared.id, "buy")).toThrow("进行中");
    const separate = app.repos.fishMarketDeals.create(other.id, { ...plan, baseUrl: "https://another-game.example" });
    expect(app.repos.fishMarketDeals.claim(other.id, separate.id, "buy").started).toBe(true);
  });
});
