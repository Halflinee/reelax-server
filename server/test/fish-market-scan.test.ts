import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeFishMarket, type FishMarketBatch } from "../src/services/fish-market-scan.ts";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { GameClientError, GAME_ERROR_CODES } from "../src/game/errors.ts";

const fish = { id: "fish", name: "测试鱼", biomeId: "map", biomeName: "地图", rarity: "common", rarityLabel: "普通", sellPrice: 50 };
const config = { sellerFeeBasisPoints: 500, maxFishOrderQuantity: 100, maxActiveOrdersPerPlayer: 10, activeOrderCount: 0, fishMinimumPrices: [] };
const book = { version: 1, buyLevels: [{ unitPrice: 100, quantity: 10 }], sellLevels: [{ unitPrice: 120, quantity: 10 }] };

describe("鱼类行情利润计算", () => {
  it("区分现价往返亏损与挂单预测收益，手续费按每条向上取整", () => {
    const row = analyzeFishMarket(fish, 3, 1000, config, book);
    expect(row.immediate).toMatchObject({ costGold: 360, grossGold: 300, feeGold: 15, netGold: 285, profitGold: -75 });
    expect(row.waiting).toMatchObject({ buyPrice: 101, sellPrice: 119, costGold: 303, grossGold: 357, feeGold: 18, netGold: 339, profitGold: 36, breakEvenPrice: 107 });
    expect(row.waitingWithinLimits).toBe(true);
  });
  it("按盘口深度累计成本和收入，不用买一卖一乘全部数量", () => {
    const input = { version: 2, buyLevels: [{ unitPrice: 90, quantity: 3 }, { unitPrice: 100, quantity: 1 }], sellLevels: [{ unitPrice: 130, quantity: 3 }, { unitPrice: 120, quantity: 1 }] };
    const copy = structuredClone(input);
    const row = analyzeFishMarket(fish, 3, 1000, config, input);
    expect(row.immediate).toMatchObject({ costGold: 380, grossGold: 280, feeGold: 15, profitGold: -115 });
    expect(row.immediate?.buyFills).toEqual([{ unitPrice: 120, quantity: 1, gold: 120 }, { unitPrice: 130, quantity: 2, gold: 260 }]);
    expect(input).toEqual(copy);
  });
  it("数量不足保留挂单预测，但不给部分数量冒充完整往返", () => {
    const row = analyzeFishMarket(fish, 11, 10000, config, book);
    expect(row.immediate).toBeNull(); expect(row.waiting?.quantity).toBe(11);
    expect(row.notes.join()).toContain("数量不足");
  });
  it.each([
    { version: 1, buyLevels: [], sellLevels: [] },
    { version: 1, buyLevels: book.buyLevels, sellLevels: [] },
    { version: 1, buyLevels: [], sellLevels: book.sellLevels },
  ])("缺少双边报价不虚构买卖价格 %j", (input) => {
    const row = analyzeFishMarket(fish, 1, 1000, config, input);
    expect(row.waiting).toBeNull(); expect(row.immediate).toBeNull(); expect(row.waitingWithinLimits).toBe(false);
  });
  it("报价交叉时不将匿名快照标为现成套利", () => {
    const row = analyzeFishMarket(fish, 1, 1000, config, { ...book, buyLevels: [{ unitPrice: 125, quantity: 10 }] });
    expect(row.waiting).toBeNull(); expect(row.immediate).toBeNull(); expect(row.notes.join()).toContain("交叉");
  });
  it("没有两个不同的可用整数价时不生成挂单方案", () => {
    const row = analyzeFishMarket(fish, 1, 1000, config, { ...book, sellLevels: [{ unitPrice: 102, quantity: 10 }] });
    expect(row.waiting).toBeNull(); expect(row.notes.join()).toContain("整数价格空档");
  });
  it("市场底价参与选价，不能向低于底价的买盘卖出", () => {
    const row = analyzeFishMarket(fish, 1, 1000, { ...config, fishMinimumPrices: [{ biomeId: "map", rarity: "common", configuredMinimumUnitPrice: 110 }] }, book);
    expect(row.waiting?.buyPrice).toBe(110); expect(row.immediate).toBeNull(); expect(row.notes.join()).toContain("卖出底价");
  });
  it("逐档累计时不将低于底价的后续买盘计为可卖数量", () => {
    const row = analyzeFishMarket(fish, 3, 1000, config, { ...book, buyLevels: [{ unitPrice: 100, quantity: 1 }, { unitPrice: 40, quantity: 100 }] });
    expect(row.immediate).toBeNull(); expect(row.waiting?.quantity).toBe(3);
  });
  it("表面价差为正但扣税亏损时明确保留负收益", () => {
    const row = analyzeFishMarket(fish, 1, 1000, { ...config, sellerFeeBasisPoints: 3000 }, book);
    expect(row.waiting?.profitGold).toBe(-18); expect(row.notes.join()).toContain("没有正收益");
  });
  it("余额、额度和数量上限不满足时不能列为可用机会，不自动缩量", () => {
    const row = analyzeFishMarket(fish, 3, 302, { ...config, maxFishOrderQuantity: 2, activeOrderCount: 10 }, book);
    expect(row.waiting?.quantity).toBe(3); expect(row.waitingWithinLimits).toBe(false);
    expect(row.notes.join()).toMatch(/单笔上限.*额度已满.*本金超过/);
  });
  it("零税与百分百税率正确处理保本价和净利润", () => {
    expect(analyzeFishMarket(fish, 3, 1000, { ...config, sellerFeeBasisPoints: 0 }, book).waiting).toMatchObject({ feeGold: 0, profitGold: 54, breakEvenPrice: 101 });
    expect(analyzeFishMarket(fish, 3, 1000, { ...config, sellerFeeBasisPoints: 10000 }, book).waiting).toMatchObject({ feeGold: 357, netGold: 0, profitGold: -303, breakEvenPrice: null });
  });
  it("大额计算不丢精度，金额超范围时明确拒绝", () => {
    expect(() => analyzeFishMarket(fish, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, config, book)).toThrow("精确计算范围");
  });
});

let app: FullApp; let seq = 0;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
function fixture() {
  const user = app.seedApprovedUser(`market-scan-${++seq}@example.com`); const accountId = app.seedAccount(user.id, "行情账号");
  app.repos.accounts.update(accountId, user.id, { baseUrl: `https://market-scan-${seq}.example` });
  const calls: { path: string; method: string }[] = [];
  const state = { fee: 500, gold: 1000, failFish: "", malformed: false, access: true };
  vi.spyOn(app.registry.require(accountId).client, "request").mockImplementation(async (path, options) => {
    calls.push({ path, method: options?.method ?? "GET" });
    if (path === "/api/content/bootstrap") return { biomes: [{ id: "map", name: "地图" }], fish: [fish, { ...fish, id: "fish2", name: "鱼二" }] };
    if (path === "/api/me") return { player: { id: accountId, nickname: "角色", gold: state.gold, canAccessMarket: state.access } };
    if (path === "/api/market/config") return { ...config, sellerFeeBasisPoints: state.fee };
    if (path.includes("/order-book?")) {
      if (state.failFish && path === `/api/market/fish/${state.failFish}/order-book?limit=50`) throw new GameClientError("请求超时（30000ms）", { code: GAME_ERROR_CODES.TIMEOUT });
      return state.malformed ? { version: 1, buyLevels: [] } : book;
    }
    throw new Error(`不应请求 ${path}`);
  });
  const input = { accountId, fishIds: ["fish", "fish2"], quantity: 3 };
  const url = "/api/mastery-transfer-preview/market-scan";
  const scan = (extra = {}) => app.post<FishMarketBatch>(url, { ...input, ...extra }, user.jar);
  return { user, accountId, calls, state, input, url, scan };
}
describe("市场扫描只读 API", () => {
  it("本地鱼种可跨调用复用，每批仅读一次账号和税率，完全不读取专精或库存", async () => {
    const f = fixture();
    const options = await app.get(`${f.url}/options?accountId=${f.accountId}`, f.user.jar);
    expect(options.status).toBe(200); expect(options.body.fish).toHaveLength(2);
    const response = await f.scan();
    expect(response.status).toBe(200); expect(response.body.rows).toHaveLength(2);
    expect(response.body.rows[0]?.waiting?.profitGold).toBe(36);
    expect(f.calls.filter((call) => call.path === "/api/content/bootstrap")).toHaveLength(1);
    expect(f.calls.filter((call) => call.path === "/api/me")).toHaveLength(1);
    expect(f.calls.filter((call) => call.path === "/api/market/config")).toHaveLength(1);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(app.db.get<{ count: number }>("SELECT count(*) AS count FROM fish_market_transfers WHERE user_id=?", f.user.id)?.count).toBe(0);
    f.state.fee = 3000; f.state.gold = 1;
    const changed = await f.scan();
    expect(changed.body.rows[0]?.waiting?.profitGold).toBe(-54);
    expect(changed.body.rows[0]?.waitingWithinLimits).toBe(false);
  });
  it("单个盘口超时不伪装为空盘或零利润，也不影响同批其他鱼", async () => {
    const f = fixture(); f.state.failFish = "fish";
    const result = await f.scan();
    expect(result.status).toBe(200); expect(result.body.rows[0]?.error).toContain("30000ms");
    expect(result.body.rows[0]?.waiting).toBeNull(); expect(result.body.rows[1]?.waiting?.profitGold).toBe(36);
  });
  it("缺少盘口字段时明确显示数据错误", async () => {
    const f = fixture(); f.state.malformed = true;
    const result = await f.scan();
    expect(result.body.rows[0]?.error).toContain("数据不完整"); expect(result.body.rows[0]?.immediate).toBeNull();
  });
  it.each([{ quantity: 0 }, { quantity: 1.5 }, { quantity: "3" }, { fishIds: [] }, { fishIds: ["fish", "fish"] }, { fishIds: ["a", "b", "c", "d"] }, { execute: true }])("参数或执行字段不能绕过只读范围 %j", async (extra) => {
    const f = fixture(); expect((await f.scan(extra)).status).toBe(400); expect(f.calls).toHaveLength(0);
  });
  it("不属于固定资料的鱼种在读取盘口之前拒绝", async () => {
    const f = fixture(); expect((await f.scan({ fishIds: ["unknown"] })).status).toBe(400);
    expect(f.calls.some((call) => call.path.includes("/order-book"))).toBe(false);
  });
  it("未登录、未审批和其他人的账号不能扫描或读取选项", async () => {
    const f = fixture(); const other = app.seedApprovedUser(`scan-other-${seq}@example.com`);
    expect((await app.post(f.url, f.input)).status).toBe(401);
    expect((await app.post(f.url, f.input, other.jar)).status).toBe(404);
    expect((await app.get(`${f.url}/options?accountId=${f.accountId}`, other.jar)).status).toBe(404);
    app.repos.users.setStatus(f.user.id, "pending");
    expect((await f.scan()).status).toBe(403); expect(f.calls).toHaveLength(0);
  });
  it("账号没有市场权限时不读取任何盘口", async () => {
    const f = fixture(); f.state.access = false;
    expect((await f.scan()).status).toBe(400); expect(f.calls.some((call) => call.path.includes("/order-book"))).toBe(false);
  });
});
