import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import type { FishTradeQuote, MasteryDemandOptions, MasterySupplyPreview } from "../src/services/mastery-supply-service.ts";
import { checkFishBook } from "../src/services/mastery-supply-service.ts";
import type { FishTransferView } from "../src/services/fish-transfer-service.ts";
import { FishTransferService } from "../src/services/fish-transfer-service.ts";
import type { TradePreview } from "../src/services/trade-preview-service.ts";

let app: FullApp; let seq = 0;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
const fishId = "fish-a"; const biomeId = "map-a";
const inventory = (quantity: number, extra = {}) => ({ fish: [{ fishId, quantity, isLocked: false, ...extra }] });
const mastery = (remainingQuantity: number) => ({ biomes: [{ biomeId, isUnlocked: true,
  rarities: [{ rarity: "common", fish: { id: fishId }, remainingQuantity, availableQuantity: 0 }] }] });
const catalog = { biomes: [{ id: biomeId, name: "溪流" }], fish: [{ id: fishId, name: "测试专精鱼", biomeId, rarity: "common", sellPrice: 100 }] };
type Order = { id: string; side: "buy" | "sell"; status: string; asset: { type: "fish"; fish: { fishId: string } };
  limitUnitPrice: number; initialQuantity: number; remainingQuantity: number; grossFilled: number; feeCharged: number };
type Trade = { id: string; role: "buyer" | "seller"; asset: Order["asset"]; quantity: number; unitPrice: number; gross: number; fee: number | null; sellerProceeds: number | null };
function fixture() {
  const user = app.seedApprovedUser(`fish-trade-${++seq}@example.com`);
  const targetId = app.seedAccount(user.id, "需求号"); const sourceId = app.seedAccount(user.id, "供给号");
  const states = {
    buyer: { player: { id: `buyer-${seq}`, nickname: "需求角色", gold: 2000, canAccessMarket: true }, mastery: mastery(5), inventory: inventory(1), orders: [] as Order[], trades: [] as Trade[] },
    seller: { player: { id: `seller-${seq}`, nickname: "供给角色", gold: 1000, canAccessMarket: true }, mastery: mastery(2), inventory: inventory(8), orders: [] as Order[], trades: [] as Trade[] },
  };
  const control = { fee: 500, maxQuantity: 100, maxOrders: 10, minPrice: 100,
    externalBuys: [] as { unitPrice: number; quantity: number }[], externalSells: [] as { unitPrice: number; quantity: number }[],
    afterBuy: () => {}, afterSell: () => {}, beforeBook: () => {}, failBuy: false, failSell: false,
    buyResponseLost: false, sellResponseLost: false, thirdParty: false, partial: false };
  const calls: { role: string; path: string; method: string; body: any; key: string | undefined }[] = [];
  for (const [role, id] of [["buyer", targetId], ["seller", sourceId]] as const) {
    const state = states[role];
    vi.spyOn(app.registry.require(id).client, "request").mockImplementation(async (path, opts = {}) => {
      const method = opts.method ?? "GET";
      calls.push({ role, path, method, body: opts.body, key: opts.headers?.["Idempotency-Key"] });
      if (path === "/api/me") return { player: { ...state.player } };
      if (path === "/api/mastery") return structuredClone(state.mastery);
      if (path === "/api/inventory/fish") return structuredClone(state.inventory);
      if (path === "/api/content/bootstrap") return catalog;
      if (path === "/api/market/config") return { sellerFeeBasisPoints: control.fee, activeOrderCount: state.orders.filter((order) => order.status === "active").length,
        maxActiveOrdersPerPlayer: control.maxOrders, maxFishOrderQuantity: control.maxQuantity,
        fishMinimumPrices: [{ biomeId, rarity: "common", configuredMinimumUnitPrice: control.minPrice }] };
      if (path === `/api/market/fish/${fishId}/order-book?limit=50`) {
        control.beforeBook();
        const buys = [...control.externalBuys, ...states.buyer.orders.filter((order) => order.status === "active").map((order) => ({ unitPrice: order.limitUnitPrice, quantity: order.remainingQuantity }))];
        const aggregate = new Map<number, number>();
        for (const level of buys) aggregate.set(level.unitPrice, (aggregate.get(level.unitPrice) ?? 0) + level.quantity);
        return { version: 1, buyLevels: [...aggregate].map(([unitPrice, quantity]) => ({ unitPrice, quantity })), sellLevels: control.externalSells };
      }
      if (path.startsWith("/api/market/me/orders?")) return { orders: structuredClone(state.orders), nextCursor: null };
      if (path === "/api/market/me/trades?assetType=fish&limit=50") return { trades: structuredClone(state.trades) };
      if (path === "/api/market/orders" && method === "POST") {
        const body = opts.body as { side: "buy" | "sell"; assetType: string; fishId: string; quantity: number; limitUnitPrice: number };
        expect(body).toEqual({ assetType: "fish", side: role === "buyer" ? "buy" : "sell", fishId, quantity: body.quantity, limitUnitPrice: body.limitUnitPrice });
        expect(opts.headers?.["Idempotency-Key"]).toMatch(/^[a-f\d-]{36}$/);
        if (role === "buyer" && control.failBuy || role === "seller" && control.failSell) throw new Error("模拟写操作超时");
        const order: Order = { id: `${role}-order-${seq}-${state.orders.length}`, side: body.side, status: "active", asset: { type: "fish", fish: { fishId } },
          limitUnitPrice: body.limitUnitPrice, initialQuantity: body.quantity, remainingQuantity: body.quantity, grossFilled: 0, feeCharged: 0 };
        state.orders.unshift(order);
        if (role === "buyer") {
          state.player.gold -= body.quantity * body.limitUnitPrice; control.afterBuy();
          if (control.buyResponseLost) throw new Error("买单已提交但响应丢失");
        } else {
          const buy = states.buyer.orders[0]!;
          const quantity = control.partial ? 1 : body.quantity; const gross = quantity * body.limitUnitPrice; const fee = Math.floor(gross * control.fee / 10000);
          for (const current of [buy, order]) { current.remainingQuantity -= quantity; current.status = current.remainingQuantity ? "active" : "filled"; current.grossFilled += gross; }
          order.feeCharged = fee;
          const tradeId = `trade-${seq}`;
          states.buyer.trades.unshift({ id: tradeId, role: "buyer", asset: order.asset, quantity, unitPrice: body.limitUnitPrice, gross, fee: null, sellerProceeds: null });
          states.seller.trades.unshift({ id: control.thirdParty ? "another-trade" : tradeId, role: "seller", asset: order.asset, quantity, unitPrice: body.limitUnitPrice, gross, fee, sellerProceeds: gross - fee });
          states.buyer.inventory.fish[0]!.quantity += quantity; states.seller.inventory.fish[0]!.quantity -= quantity;
          control.afterSell();
          if (control.sellResponseLost) throw new Error("卖出已提交但响应丢失");
        }
        return { order: structuredClone(order) };
      }
      throw new Error(`意外接口 ${method} ${path}`);
    });
  }
  const selection = { targetAccountId: targetId, biomeId, fishId };
  const input = { ...selection, sourceAccountId: sourceId, quantity: 3, unitPrice: 100 };
  const url = (route: string, extra: Record<string, string | number> = {}) => `/api/mastery-transfer-preview/${route}?${new URLSearchParams(Object.entries({ ...input, ...extra }).map(([k, v]) => [k, String(v)]))}`;
  const quote = async (extra = {}) => app.get<FishTradeQuote>(url("quote", extra), user.jar);
  const prepare = async () => {
    const response = await quote(); expect(response.status).toBe(200); expect(response.body.issues).toEqual([]);
    expect(response.body.confirmation).toBeDefined(); return response.body.confirmation!.id;
  };
  const confirm = (id: string) => app.post<FishTransferView>(`/api/mastery-transfer-preview/operations/${id}/confirm`, { confirmed: true, acceptPublicMatching: true }, user.jar);
  const finished = async (id: string) => {
    let result: FishTransferView | undefined;
    await vi.waitFor(async () => { result = (await app.get<FishTransferView>(`/api/mastery-transfer-preview/operations/${id}`, user.jar)).body; expect(result.status).not.toBe("executing"); }, { timeout: 3000, interval: 10 });
    return result!;
  };
  const writes = () => calls.filter((call) => call.method !== "GET");
  return { user, targetId, sourceId, states, control, calls, selection, input, url, quote, prepare, confirm, finished, writes };
}

describe("需求筛选和全部账号供给", () => {
  it("按需求账号真实地图和专精目标生成下拉项，缺口扣除现有鱼", async () => {
    const f = fixture();
    const response = await app.get<MasteryDemandOptions>(`/api/mastery-transfer-preview/demand?targetAccountId=${f.targetId}`, f.user.jar);
    expect(response.status).toBe(200);
    expect(response.body.biomes).toEqual([{ id: biomeId, name: "溪流", fish: [{ id: fishId, name: "测试专精鱼", rarityLabel: "普通", missing: 4 }] }]);
    expect(f.writes()).toHaveLength(0);
  });
  it("默认列出需求方之外所有本用户账号，失败项不伪装成零库存", async () => {
    const f = fixture();
    const failedId = app.seedAccount(f.user.id, "读取失败号");
    vi.spyOn(app.registry.require(failedId).client, "request").mockRejectedValue(new Error("登录已失效"));
    const other = app.seedApprovedUser(`not-visible-${seq}@example.com`); app.seedAccount(other.id, "别人的账号");
    const response = await app.get<MasterySupplyPreview>(`/api/mastery-transfer-preview/supply?${new URLSearchParams(f.selection)}`, f.user.jar);
    expect(response.status).toBe(200); expect(response.body.suppliers).toHaveLength(2);
    expect(response.body.suppliers[0]).toMatchObject({ accountId: f.sourceId, owned: 8, reserved: 2, protected: 0, canProvide: 6 });
    expect(response.body.suppliers[1]).toMatchObject({ accountId: failedId, owned: null, canProvide: null });
    expect(response.body.suppliers[1]!.issue).toContain("登录已失效");
    expect(response.body.suppliers.some((row) => row.accountId === f.targetId)).toBe(false); expect(f.writes()).toHaveLength(0);
  });
  it("锁定鱼及自身专精保留不作为供给", async () => {
    const f = fixture(); f.states.seller.inventory = inventory(8, { isManuallyLocked: true });
    const response = await f.quote();
    expect(response.body.issues.join(" ")).toContain("可出售余量"); expect(response.body.confirmation).toBeUndefined();
  });
  it("拒绝过期地图、鱼种和同游戏角色的重复记录", async () => {
    const f = fixture();
    expect((await f.quote({ biomeId: "wrong-map" })).status).toBe(409);
    f.states.seller.player.id = f.states.buyer.player.id;
    expect((await f.quote()).status).toBe(409); expect(f.writes()).toHaveLength(0);
  });
  it("任何越权账号在读取游戏之前被拒绝", async () => {
    const f = fixture(); const other = app.seedApprovedUser(`foreign-${seq}@example.com`); const foreign = app.seedAccount(other.id);
    expect((await f.quote({ sourceAccountId: foreign })).status).toBe(404);
    expect((await f.quote({ targetAccountId: foreign })).status).toBe(404);
    expect(f.calls).toHaveLength(0);
  });
  it.each([{ quantity: "0" }, { quantity: "1.5" }, { unitPrice: "-1" }, { unitPrice: "9007199254740992" }, { execute: "true" }])("交易参数边界在任何游戏请求前拒绝 %j", async (extra) => {
    const f = fixture();
    expect((await f.quote(extra)).status).toBe(400); expect(f.calls).toHaveLength(0);
  });
  it("最低价、专精缺口、可供量、单笔上限和挂单额度均限制确认", async () => {
    const f = fixture();
    expect((await f.quote({ unitPrice: 99 })).body.issues.join(" ")).toContain("不能低于");
    expect((await f.quote({ quantity: 5 })).body.issues.join(" ")).toContain("专精缺口");
    expect((await f.quote({ quantity: 7 })).body.issues.join(" ")).toContain("可出售余量");
    f.control.maxQuantity = 2;
    expect((await f.quote()).body.issues.join(" ")).toContain("单笔上限");
    f.control.maxOrders = 0;
    expect((await f.quote()).body.issues.join(" ")).toContain("挂单额度");
    expect(f.writes()).toHaveLength(0);
  });
});

describe("公开盘口竞争检查", () => {
  it.each([
    { buyLevels: [{ unitPrice: 110, quantity: 7 }], sellLevels: [] },
    { buyLevels: [{ unitPrice: 100, quantity: 7 }], sellLevels: [] },
    { buyLevels: [], sellLevels: [{ unitPrice: 99, quantity: 7 }] },
  ])("价格数量不能指定订单，任何可成交竞争盘都阻止首次挂单 %j", (book) => {
    expect(() => checkFishBook({ version: 1, ...book }, 100)).toThrow("其他可成交订单");
  });
  it("挂单后必须仅剩本次价格和完整数量，额外同价数量也拒绝", () => {
    expect(() => checkFishBook({ version: 1, buyLevels: [{ unitPrice: 100, quantity: 3 }], sellLevels: [] }, 100, 3)).not.toThrow();
    expect(() => checkFishBook({ version: 1, buyLevels: [{ unitPrice: 100, quantity: 4 }], sellLevels: [] }, 100, 3)).toThrow();
  });
});

describe("专精鱼确认交易", () => {
  it("先买单后卖单，仅匹配双方订单及新成交后完成；预览本身无写操作", async () => {
    const f = fixture(); const id = await f.prepare(); expect(f.writes()).toHaveLength(0);
    expect((await f.confirm(id)).status).toBe(200);
    const result = await f.finished(id);
    expect(result.status).toBe("completed"); expect(result.settlement).toMatchObject({ quantity: 3, grossGold: 300, feeGold: 15, netGold: 285 });
    expect(f.writes().map((call) => call.body.side)).toEqual(["buy", "sell"]);
    expect(f.writes()[0]!.key).not.toBe(f.writes()[1]!.key);
    expect(result).not.toHaveProperty("buyKey"); expect(result).not.toHaveProperty("baseline");
  });
  it("重复及并发确认同一预览只写一次买单和卖单", async () => {
    const f = fixture(); const id = await f.prepare(); await Promise.all([f.confirm(id), f.confirm(id), f.confirm(id)]);
    expect((await f.finished(id)).status).toBe("completed"); await f.confirm(id); expect(f.writes()).toHaveLength(2);
  });
  it("不接受公开撮合、篡改数量、过期和越权均不能确认", async () => {
    const f = fixture(); const id = await f.prepare();
    const endpoint = `/api/mastery-transfer-preview/operations/${id}/confirm`;
    expect((await app.post(endpoint, { confirmed: true }, f.user.jar)).status).toBe(400);
    expect((await app.post(endpoint, { confirmed: true, acceptPublicMatching: true, quantity: 999 }, f.user.jar)).status).toBe(400);
    const other = app.seedApprovedUser(`other-confirm-${seq}@example.com`);
    expect((await app.post(endpoint, { confirmed: true, acceptPublicMatching: true }, other.jar)).status).toBe(404);
    app.db.run("UPDATE fish_market_transfers SET expires_at=0 WHERE id=?", id);
    expect((await f.confirm(id)).status).toBe(409); expect(f.writes()).toHaveLength(0);
  });
  it.each(["balance", "stock", "fee", "identity", "competing", "mastery"])("确认前条件变化 %s 停止且不挂单", async (change) => {
    const f = fixture(); const id = await f.prepare();
    if (change === "balance") f.states.buyer.player.gold = 0;
    if (change === "stock") f.states.seller.inventory.fish[0]!.quantity = 2;
    if (change === "fee") f.control.fee = 1000;
    if (change === "identity") f.states.seller.player.id = "different-player";
    if (change === "competing") f.control.externalBuys.push({ unitPrice: 110, quantity: 7 });
    if (change === "mastery") f.states.buyer.mastery = mastery(1);
    await f.confirm(id); expect((await f.finished(id)).status).toBe("failed"); expect(f.writes()).toHaveLength(0);
  });
  it("再次检查盘口时出现高价买单，仍在首笔写入之前停止", async () => {
    const f = fixture(); const id = await f.prepare(); let reads = 0;
    f.control.beforeBook = () => { if (++reads === 2) f.control.externalBuys.push({ unitPrice: 110, quantity: 7 }); };
    await f.confirm(id); expect((await f.finished(id)).status).toBe("failed"); expect(f.writes()).toHaveLength(0);
  });
  it("买单已被别人先成交时不再让供给方卖出", async () => {
    const f = fixture(); const id = await f.prepare();
    f.control.afterBuy = () => { const buy = f.states.buyer.orders[0]!; buy.status = "filled"; buy.remainingQuantity = 0; buy.grossFilled = 300; };
    await f.confirm(id); expect((await f.finished(id)).status).toBe("review_required"); expect(f.writes()).toHaveLength(1);
  });
  it.each(["competition", "stock", "mastery", "identity", "fee", "banned", "deleted"])("挂买单后变化 %s 不再卖出，保留待核对记录", async (change) => {
    const f = fixture(); const id = await f.prepare();
    f.control.afterBuy = () => {
      if (change === "competition") f.control.externalBuys.push({ unitPrice: 100, quantity: 1 });
      if (change === "stock") f.states.seller.inventory.fish[0]!.quantity = 2;
      if (change === "mastery") f.states.buyer.mastery = mastery(1);
      if (change === "identity") f.states.seller.player.id = "changed-after-buy";
      if (change === "fee") f.control.fee = 1000;
      if (change === "banned") app.repos.users.setStatus(f.user.id, "banned");
      if (change === "deleted") app.repos.accounts.delete(f.sourceId, f.user.id);
    };
    await f.confirm(id);
    if (change === "banned") await vi.waitFor(() => expect(app.repos.fishTransfers.find(f.user.id, id)!.status).toBe("review_required"));
    else expect((await f.finished(id)).status).toBe("review_required");
    expect(f.writes()).toHaveLength(1);
  });
  it.each(["failBuy", "failSell", "buyResponseLost", "sellResponseLost"] as const)("写操作超时 %s 不自动重试或补单", async (kind) => {
    const f = fixture(); const id = await f.prepare(); f.control[kind] = true;
    await f.confirm(id); expect((await f.finished(id)).status).toBe("review_required");
    const writes = f.writes().length; await f.confirm(id); expect(f.writes()).toHaveLength(writes);
  });
  it.each(["thirdParty", "partial"] as const)("第三方或部分成交 %s 不报告完成", async (kind) => {
    const f = fixture(); const id = await f.prepare(); f.control[kind] = true;
    await f.confirm(id); expect((await f.finished(id)).status).toBe("review_required");
  });
  it("结算金额异常只核对，不自动补转；修正读取后可只读核对完成", async () => {
    const f = fixture(); const id = await f.prepare();
    f.control.afterSell = () => { f.states.seller.trades[0]!.sellerProceeds = 1; };
    await f.confirm(id); expect((await f.finished(id)).status).toBe("review_required");
    f.states.seller.trades[0]!.sellerProceeds = 285;
    const writes = f.writes().length;
    const response = await app.post<FishTransferView>(`/api/mastery-transfer-preview/operations/${id}/check`, {}, f.user.jar);
    expect(response.body.status).toBe("completed"); expect(f.writes()).toHaveLength(writes);
  });
  it("待核对记录阻止再次交易，人工结束不撤单、不退款、不再次成交", async () => {
    const f = fixture(); const id = await f.prepare(); const next = await f.prepare(); f.control.failBuy = true;
    await f.confirm(id); await f.finished(id);
    expect((await f.confirm(next)).status).toBe(409);
    const writes = f.writes().length;
    const response = await app.post<FishTransferView>(`/api/mastery-transfer-preview/operations/${id}/close`, { confirmed: true }, f.user.jar);
    expect(response.body.status).toBe("closed"); expect(f.writes()).toHaveLength(writes);
  });
  it("重启仅将进行中记录改为待核对，不恢复自动写操作", async () => {
    const f = fixture(); const id = await f.prepare(); app.repos.fishTransfers.claim(f.user.id, id);
    new FishTransferService({ accounts: app.accounts, registry: app.registry, repos: app.repos });
    expect(app.repos.fishTransfers.find(f.user.id, id)!.status).toBe("review_required"); expect(f.writes()).toHaveLength(0);
  });
  it("历史同鱼成交不能冒充本次成交", async () => {
    const f = fixture(); const id = `historical-${seq}`;
    const trade: Trade = { id, role: "seller", asset: { type: "fish", fish: { fishId } }, quantity: 3, unitPrice: 100, gross: 300, fee: 15, sellerProceeds: 285 };
    f.states.buyer.trades.push({ ...trade, role: "buyer", fee: null, sellerProceeds: null }); f.states.seller.trades.push(trade);
    const operation = await f.prepare();
    f.control.afterSell = () => { f.states.buyer.trades.shift(); f.states.seller.trades.shift(); };
    await f.confirm(operation); expect((await f.finished(operation)).status).toBe("review_required");
  });
  it("跨平台用户绑定同一游戏角色也受持久化交易限制", async () => {
    const first = fixture(); const firstId = await first.prepare();
    const second = fixture(); second.states.buyer.player.id = first.states.buyer.player.id;
    const secondId = await second.prepare();
    app.repos.fishTransfers.claim(first.user.id, firstId);
    expect((await second.confirm(secondId)).status).toBe(409);
    expect(second.writes()).toHaveLength(0);
    app.repos.fishTransfers.update(first.user.id, firstId, "closed", {});
  });
  it("金币集中与专精鱼交易互相阻止同一游戏账号的并发交易", async () => {
    const f = fixture(); const fishId = await f.prepare(); const quote = app.repos.fishTransfers.find(f.user.id, fishId)!.quote;
    const preview: TradePreview = { createdAt: Date.now(), baseUrl: quote.baseUrl, payer: quote.target, receiver: quote.source,
      requestedGold: 1, grossGold: 1, feeGold: 0, netGold: 1, feeBasisPoints: 0, candidate: null, candidateCount: 0, scannedGearCount: 0, issues: [] };
    const gold = app.repos.goldTransfers.create(f.user.id, preview);
    app.repos.goldTransfers.claim(f.user.id, gold.id);
    expect(() => app.repos.fishTransfers.claim(f.user.id, fishId)).toThrow("金币或专精鱼交易");
    app.repos.goldTransfers.update(f.user.id, gold.id, "closed", {});
    app.repos.fishTransfers.claim(f.user.id, fishId);
    const anotherGold = app.repos.goldTransfers.create(f.user.id, preview);
    expect(() => app.repos.goldTransfers.claim(f.user.id, anotherGold.id)).toThrow("进行中或待核对");
    app.repos.fishTransfers.update(f.user.id, fishId, "closed", {});
  });
  it("最近记录保留所有待核对项目，不被十条已结束记录挤掉", async () => {
    const f = fixture(); const id = await f.prepare(); const quote = app.repos.fishTransfers.find(f.user.id, id)!.quote;
    app.repos.fishTransfers.update(f.user.id, id, "review_required", { message: "旧记录仍需核对" });
    for (let index = 0; index < 12; index++) {
      const closed = app.repos.fishTransfers.create(f.user.id, quote); app.repos.fishTransfers.update(f.user.id, closed.id, "closed", {});
    }
    const response = await app.get<FishTransferView[]>("/api/mastery-transfer-preview/operations", f.user.jar);
    expect(response.body.some((item) => item.id === id && item.status === "review_required")).toBe(true);
    expect(response.body.filter((item) => item.status === "closed")).toHaveLength(10);
  });
});
