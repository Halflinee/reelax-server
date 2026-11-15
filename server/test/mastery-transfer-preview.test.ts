import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { planMasteryTransfer, type MasteryTransferPreview } from "../src/services/mastery-transfer-preview.ts";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { GameClientError } from "../src/game/errors.ts";
import type { MasteryMarketPreview } from "../src/services/mastery-market-preview.ts";

const fish = (fishId: string, count: number, extra = {}) => ({ fishId, quantity: count, isLocked: false, ...extra });
const mastery = (entries: [string, number][]) => ({ biomes: [{
  biomeId: "map-new", isUnlocked: true,
  rarities: entries.map(([id, remainingQuantity]) => ({
    rarity: "mythic", fish: { id }, remainingQuantity, availableQuantity: 0, isWaiting: false,
  })),
}] });
function data() {
  return {
    sourceMastery: mastery([["a", 1], ["b", 3]]), sourceInventory: { fish: [fish("a", 4)] },
    targetMastery: mastery([["a", 5], ["b", 1]]), targetInventory: { fish: [fish("a", 1), fish("b", 4)] },
    catalog: {
      fish: ["a", "b", "c", "d"].map((id) => ({ id, name: `鱼${id}`, rarity: "mythic", biomeId: "map-new", sellPrice: 100 })),
      biomes: [{ id: "map-new", name: "新增地图" }],
    },
    marketAvailable: true,
  };
}

describe("专精鱼供需分配", () => {
  it("按各自目标算缺口，先自留，并优先用回交换鱼补出鱼号专精", () => {
    const rows = planMasteryTransfer(data());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fishId: "a", biomeName: "新增地图", targetMissing: 4, sourceOwned: 4, sourceReserved: 1,
      sourceCanProvide: 3, suggestedQuantity: 3,
      returnFish: [{ fishId: "b", quantity: 3, sourceNeedFilled: 3 }],
    });
  });
  it("出鱼号自己都不够时不建议调出", () => {
    const input = data();
    input.sourceMastery = mastery([["a", 5]]);
    expect(planMasteryTransfer(input)[0]).toMatchObject({ sourceReserved: 4, sourceCanProvide: 0, suggestedQuantity: 0 });
  });
  it.each([{ isLocked: true }, { isManuallyLocked: true }, { isMasteryLocked: true }, { titanValueSummary: { count: 1 } }])(
    "锁定或倍率保护的库存不调出：%j", (extra) => {
      const input = data();
      input.sourceInventory.fish = [fish("a", 4, extra)];
      expect(planMasteryTransfer(input)[0]).toMatchObject({ sourceProtected: 4, sourceCanProvide: 0, suggestedQuantity: 0 });
    },
  );
  it("自身保留与锁定保护重叠时不重复扣除，始终留足自身需求", () => {
    const input = data();
    input.sourceInventory.fish = [fish("a", 3, { isLocked: true }), fish("a", 2)];
    expect(planMasteryTransfer(input)[0]).toMatchObject({ sourceOwned: 5, sourceReserved: 1, sourceProtected: 3, sourceCanProvide: 2 });
  });
  it("收鱼号已经有足够的鱼时不再补充，也不把锁定库存当成缺鱼", () => {
    const input = data();
    input.targetInventory.fish = [fish("a", 5, { isLocked: true }), fish("b", 4)];
    expect(planMasteryTransfer(input)).toEqual([]);
  });
  it("回交换鱼不足时明确限制数量，不建议单向送鱼", () => {
    const input = data();
    input.targetInventory.fish = [fish("a", 1), fish("b", 2)];
    const [row] = planMasteryTransfer(input);
    expect(row).toMatchObject({ sourceCanProvide: 3, suggestedQuantity: 1, returnFish: [{ quantity: 1 }] });
    expect(row!.notes.join(" ")).toContain("回交换");
  });
  it("回交换优先补出鱼账号的缺口，而非只选回收价最低的鱼", () => {
    const input = data();
    input.targetInventory.fish.push(fish("c", 10));
    input.catalog.fish[1]!.sellPrice = 1000;
    input.catalog.fish[2]!.sellPrice = 1;
    const [row] = planMasteryTransfer(input);
    expect(row!.returnFish).toEqual([{ fishId: "b", name: "鱼b", quantity: 3, sourceNeedFilled: 3 }]);
  });
  it("同一批回交换库存不会分配给多条方案", () => {
    const input = data();
    input.sourceMastery = mastery([]);
    input.sourceInventory.fish = [fish("a", 3), fish("c", 3)];
    input.targetMastery = mastery([["a", 3], ["c", 3]]);
    input.targetInventory.fish = [fish("b", 4)];
    const rows = planMasteryTransfer(input);
    expect(rows.map((row) => row.suggestedQuantity)).toEqual([3, 1]);
    expect(rows.flatMap((row) => row.returnFish).reduce((sum, item) => sum + item.quantity, 0)).toBe(4);
  });
  it("回交换鱼同样保留自身需求，并排除保护鱼与不同稀有度", () => {
    const input = data();
    input.targetInventory.fish = [fish("b", 1), fish("c", 5, { isLocked: true }), fish("d", 10)];
    input.catalog.fish[3]!.rarity = "arcane";
    expect(planMasteryTransfer(input)[0]).toMatchObject({ sourceCanProvide: 3, suggestedQuantity: 0, returnFish: [] });
  });
  it("同名不同 ID 的鱼不能代替目标鱼", () => {
    const input = data();
    input.catalog.fish[0]!.name = "同名鱼";
    input.catalog.fish[2]!.name = "同名鱼";
    input.sourceInventory.fish = [fish("c", 20)];
    expect(planMasteryTransfer(input)[0]).toMatchObject({ fishId: "a", sourceOwned: 0, suggestedQuantity: 0 });
  });
  it("低稀有度仅展示供需，不生成匿名市场交易方案", () => {
    const input = data();
    input.catalog.fish.forEach((item) => { item.rarity = "common"; });
    const [row] = planMasteryTransfer(input);
    expect(row).toMatchObject({ sourceCanProvide: 3, suggestedQuantity: 0 });
    expect(row!.notes.join(" ")).toContain("不支持以物易物");
  });
  it("未解锁或等待中的目标不计入当前缺口", () => {
    const input = data();
    input.targetMastery.biomes[0]!.isUnlocked = false;
    expect(planMasteryTransfer(input)).toEqual([]);
    input.targetMastery.biomes[0]!.isUnlocked = true;
    input.targetMastery.biomes[0]!.rarities.forEach((item) => { item.isWaiting = true; });
    expect(planMasteryTransfer(input)).toEqual([]);
  });
  it("资料缺失时明确报错，不把失败当成空库存", () => {
    const input = data();
    input.catalog.fish = [];
    expect(() => planMasteryTransfer(input)).toThrow("资料与账号数据不一致");
    expect(() => planMasteryTransfer({ ...data(), targetInventory: {} })).toThrow("鱼获背包");
  });
  it("市场不可用时仍列出供需，但不生成交换建议", () => {
    const [row] = planMasteryTransfer({ ...data(), marketAvailable: false });
    expect(row).toMatchObject({ sourceCanProvide: 3, suggestedQuantity: 0, returnFish: [] });
  });
});

let app: FullApp;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
let seq = 0;
function setup() {
  const user = app.seedApprovedUser(`fish-preview${++seq}@example.com`);
  const sourceId = app.seedAccount(user.id, "出鱼号");
  const targetId = app.seedAccount(user.id, "收鱼号");
  const input = data();
  const sourcePlayer = { id: `source-${seq}`, nickname: "出鱼角色", canAccessMarket: true };
  const targetPlayer = { id: `target-${seq}`, nickname: "收鱼角色", canAccessMarket: true, gold: 1000 };
  const config = { maxFishOrderQuantity: 100, fishMinimumPrices: [{ biomeId: "map-new", rarity: "mythic", configuredMinimumUnitPrice: 120 }] };
  const book = { version: 3, sellLevels: [{ unitPrice: 125, quantity: 2 }, { unitPrice: 130, quantity: 5 }] };
  const calls: string[] = [];
  for (const [id, role, player] of [[sourceId, "source", sourcePlayer], [targetId, "target", targetPlayer]] as const) {
    vi.spyOn(app.registry.require(id).client, "request").mockImplementation(async (path, opts = {}) => {
      expect(opts.method ?? "GET").toBe("GET");
      calls.push(`${role}:${path}`);
      if (path === "/api/me") return { player };
      if (path === "/api/mastery") return role === "source" ? input.sourceMastery : input.targetMastery;
      if (path === "/api/inventory/fish") return role === "source" ? input.sourceInventory : input.targetInventory;
      if (role === "source" && path === "/api/content/bootstrap") return input.catalog;
      if (role === "target" && path === "/api/market/config") return config;
      if (role === "target" && path === "/api/market/fish/a/order-book?limit=50") return book;
      throw new Error(`预览不能调用此接口：${path}`);
    });
  }
  const path = (sourceAccountId = sourceId, targetAccountId = targetId) =>
    `/api/mastery-transfer-preview?${new URLSearchParams({ sourceAccountId, targetAccountId })}`;
  const request = () => app.get<MasteryTransferPreview>(path(), user.jar);
  const marketPath = (extra: Record<string, string> = {}) => `/api/mastery-transfer-preview/market?${new URLSearchParams({ sourceAccountId: sourceId, targetAccountId: targetId, fishId: "a", ...extra })}`;
  const marketRequest = (extra: Record<string, string> = {}) => app.get<MasteryMarketPreview>(marketPath(extra), user.jar);
  return { user, sourceId, targetId, input, sourcePlayer, targetPlayer, calls, path, request, config, book, marketPath, marketRequest };
}

describe("专精鱼调配 API", () => {
  it("端到端读取两号供需，只调用七个只读业务接口", async () => {
    const fixture = setup();
    const response = await fixture.request();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: { nickname: "出鱼角色" }, target: { nickname: "收鱼角色" }, rows: [{ suggestedQuantity: 3 }] });
    expect(fixture.calls).toHaveLength(7);
    expect(fixture.input.sourceInventory.fish[0]!.quantity).toBe(4);
  });
  it("任一账号越权时，在所有游戏请求之前返回 404", async () => {
    const fixture = setup();
    const other = app.seedApprovedUser(`other-fish${seq}@example.com`);
    const foreign = app.seedAccount(other.id);
    expect((await app.get(fixture.path(foreign, fixture.targetId), fixture.user.jar)).status).toBe(404);
    expect((await app.get(fixture.path(fixture.sourceId, foreign), fixture.user.jar)).status).toBe(404);
    expect(fixture.calls).toHaveLength(0);
  });
  it("同一记录和同一游戏角色的重复记录均被拒绝", async () => {
    const fixture = setup();
    expect((await app.get(fixture.path(fixture.sourceId, fixture.sourceId), fixture.user.jar)).status).toBe(400);
    expect(fixture.calls).toHaveLength(0);
    fixture.targetPlayer.id = fixture.sourcePlayer.id;
    expect((await fixture.request()).status).toBe(400);
    expect(fixture.calls).toHaveLength(2);
  });
  it("未登录和未审批不能读取任何游戏数据", async () => {
    const fixture = setup();
    expect((await app.get(fixture.path())).status).toBe(401);
    app.repos.users.setStatus(fixture.user.id, "pending");
    expect((await fixture.request()).status).toBe(403);
    expect(fixture.calls).toHaveLength(0);
  });
  it("游戏读取失败返回真实原因，没有虚构的空缺口", async () => {
    const fixture = setup();
    vi.mocked(app.registry.require(fixture.sourceId).client.request).mockRejectedValueOnce(new GameClientError("请求超时"));
    const response = await fixture.request();
    expect(response.status).toBe(502);
    expect((response.body as any).error.message).toContain("请求超时");
    expect((response.body as any).rows).toBeUndefined();
  });
  it("市场权限不足时保留供需信息并说明原因", async () => {
    const fixture = setup();
    fixture.targetPlayer.canAccessMarket = false;
    const response = await fixture.request();
    expect(response.status).toBe(200);
    expect(response.body.rows[0]!.suggestedQuantity).toBe(0);
    expect(response.body.issues.join(" ")).toContain("收鱼账号尚不能使用市场");
  });
  it("没有实际交换或执行入口", async () => {
    const fixture = setup();
    expect((await app.post("/api/mastery-transfer-preview", {}, fixture.user.jar)).status).toBe(404);
    expect((await app.post("/api/mastery-transfer-preview/execute", {}, fixture.user.jar)).status).toBe(404);
    expect(fixture.calls).toHaveLength(0);
  });
});

describe("专精鱼市场购买预览 API", () => {
  it("只读最新专精和市场数据，按参数生成预算内报价", async () => {
    const fixture = setup();
    const response = await fixture.marketRequest({ quantity: "10", maxUnitPrice: "130", budget: "390" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ target: { accountId: fixture.targetId }, targetMissing: 4, orderQuantity: 3, expectedQuantity: 3, expectedCostGold: 380, reserveGold: 390 });
    expect(fixture.calls).toHaveLength(9);
    expect(fixture.calls).toContain("target:/api/market/fish/a/order-book?limit=50");
  });
  it("初次读取采用最低价，并不自动提高到卖盘最低价", async () => {
    const fixture = setup();
    const response = await fixture.marketRequest();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ maxUnitPrice: 120, bestAsk: 125, expectedQuantity: 0, pendingQuantity: 4 });
  });
  it("不能以物易物的低稀有度鱼也能预览市场购买", async () => {
    const fixture = setup();
    fixture.input.catalog.fish.forEach((entry) => { entry.rarity = "common"; });
    fixture.config.fishMinimumPrices[0]!.rarity = "common";
    expect((await fixture.request()).body.rows[0]!.suggestedQuantity).toBe(0);
    const response = await fixture.marketRequest({ maxUnitPrice: "125" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ expectedQuantity: 2, minimumUnitPrice: 120 });
  });
  it("跨用户账号、未登录或未审批均不可读取", async () => {
    const fixture = setup();
    const other = app.seedApprovedUser(`market-other${seq}@example.com`);
    const foreign = app.seedAccount(other.id);
    expect((await fixture.marketRequest({ targetAccountId: foreign })).status).toBe(404);
    expect((await fixture.marketRequest({ sourceAccountId: foreign })).status).toBe(404);
    expect((await app.get(fixture.marketPath())).status).toBe(401);
    app.repos.users.setStatus(fixture.user.id, "pending");
    expect((await fixture.marketRequest()).status).toBe(403);
    expect(fixture.calls).toHaveLength(0);
  });
  it("缺口已补齐后拒绝旧预览的购买输入", async () => {
    const fixture = setup(); fixture.input.targetInventory.fish[0]!.quantity = 5;
    const response = await fixture.marketRequest();
    expect(response.status).toBe(400);
    expect(fixture.calls.some((call) => call.includes("/api/market/"))).toBe(false);
  });
  it("只有收鱼账号需要市场权限，出鱼号的权限不影响公开市场购买", async () => {
    const fixture = setup(); fixture.sourcePlayer.canAccessMarket = false;
    expect((await fixture.marketRequest()).status).toBe(200);
    fixture.targetPlayer.canAccessMarket = false;
    expect((await fixture.marketRequest()).status).toBe(400);
  });
  it.each([{ quantity: "0" }, { quantity: "1.5" }, { maxUnitPrice: "-1" }, { maxUnitPrice: "9007199254740992" }, { budget: "-1" }, { execute: "true" }])("无效参数或执行参数被拒绝 %j", async (extra) => {
    const fixture = setup();
    expect((await fixture.marketRequest(extra as Record<string, string>)).status).toBe(400);
    expect(fixture.calls).toHaveLength(0);
  });
  it("盘口失败时如实返回错误，没有虚构的空盘口", async () => {
    const fixture = setup();
    const client = app.registry.require(fixture.targetId).client;
    vi.spyOn(client, "marketFishOrderBook").mockRejectedValueOnce(new GameClientError("市场请求超时"));
    const response = await fixture.marketRequest();
    expect(response.status).toBe(502);
    expect((response.body as any).error.message).toContain("市场请求超时");
  });
  it("该功能没有下单或执行入口", async () => {
    const fixture = setup();
    expect((await app.post("/api/mastery-transfer-preview/market", {}, fixture.user.jar)).status).toBe(404);
    expect((await app.post("/api/mastery-transfer-preview/market/execute", {}, fixture.user.jar)).status).toBe(404);
    expect(fixture.calls).toHaveLength(0);
  });
});
