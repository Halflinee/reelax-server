import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { calculateTradeGold, type TradePreview } from "../src/services/trade-preview-service.ts";
import { RARITIES } from "../src/modules/shared/rarity.ts";
import { GameClientError } from "../src/game/errors.ts";

describe("交易金额计算", () => {
  it("手续费向下取整，付款金额使用能达到目标的最小整数", () => {
    expect(calculateTradeGold(100, 1500)).toEqual({ grossGold: 117, feeGold: 17, netGold: 100 });
    expect(calculateTradeGold(100, 0)).toEqual({ grossGold: 100, feeGold: 0, netGold: 100 });
    for (const rate of [1, 333, 1500, 9999]) {
      for (const amount of [1, 2, 99, 100, 1000000, 100000000000]) {
        const result = calculateTradeGold(amount, rate);
        expect(result.netGold).toBe(amount);
        const previous = BigInt(result.grossGold - 1);
        expect(previous - previous * BigInt(rate) / 10000n).toBeLessThan(BigInt(amount));
      }
    }
  });
  it("大金额保持精度，拒绝溢出与不合法税率", () => {
    const amount = 4000000000000000;
    const result = calculateTradeGold(amount, 333);
    expect(result.netGold).toBe(amount);
    expect(BigInt(result.grossGold) * 333n / 10000n).toBe(BigInt(result.feeGold));
    expect(() => calculateTradeGold(Number.MAX_SAFE_INTEGER, 1500)).toThrow("金额过大");
    expect(() => calculateTradeGold(1, 10000)).toThrow("税率");
    expect(() => calculateTradeGold(1.5, 0)).toThrow("正整数");
  });
});

let app: FullApp;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
let seq = 0;
const gear = (id = "gear-1") => ({
  id, name: "测试手套", rarity: "common", slot: "gloves", quality: 12, upgradeLevel: 0,
  sellValue: 10, isLocked: false, equippedSlot: null, marketOrderId: null,
});

function setup() {
  const user = app.seedApprovedUser(`preview${++seq}@example.com`);
  const payerId = app.seedAccount(user.id, "付款号");
  const receiverId = app.seedAccount(user.id, "收款号");
  const payer = { id: `payer-${seq}`, nickname: "付款角色", gold: 10000, canAccessMarket: true };
  const receiver = { id: `receiver-${seq}`, nickname: "收款角色", gold: 500, canAccessMarket: true };
  const config = {
    sellerFeeBasisPoints: 1500, activeOrderCount: 0, maxActiveOrdersPerPlayer: 10,
    gearMinimumPrices: RARITIES.map((rarity) => ({ rarity, effectiveBaseMinimumUnitPrice: 1 })),
  };
  const pages: { gear: unknown[]; nextCursor?: string | null }[] = [{ gear: [gear()] }];
  const calls: { role: string; path: string; method: string }[] = [];
  for (const [id, role, player] of [[payerId, "payer", payer], [receiverId, "receiver", receiver]] as const) {
    vi.spyOn(app.registry.require(id).client, "request").mockImplementation(async (path, opts = {}) => {
      calls.push({ role, path, method: opts.method ?? "GET" });
      if ((opts.method ?? "GET") !== "GET") throw new Error("预览不能写入游戏");
      if (path === "/api/me") return { player };
      if (role === "receiver" && path === "/api/market/config") return config;
      if (role === "receiver" && path.startsWith("/api/inventory/gear")) {
        const cursor = new URL(path, "https://game.example").searchParams.get("cursor");
        return pages[cursor ? Number(cursor) : 0];
      }
      throw new Error(`未授权的游戏请求：${path}`);
    });
  }
  const path = (amount: string | number = 100, payerAccountId = payerId, receiverAccountId = receiverId) =>
    `/api/trade-preview?${new URLSearchParams({ payerAccountId, receiverAccountId, amount: String(amount) })}`;
  const read = () => app.get<TradePreview>(path(), user.jar);
  return { user, payerId, receiverId, payer, receiver, config, pages, calls, path, read };
}

describe("交易预览 API：权限、实时数据和只读边界", () => {
  it("生成含税预览，读取双方余额，所有游戏业务请求均为 GET", async () => {
    const fixture = setup();
    const response = await fixture.read();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      requestedGold: 100, grossGold: 117, feeGold: 17, netGold: 100,
      payer: { gold: 10000 }, receiver: { gold: 500 }, candidate: { id: "gear-1" }, issues: [],
    });
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);
    expect(fixture.payer.gold).toBe(10000);
    expect(fixture.receiver.gold).toBe(500);
    expect(fixture.pages[0]!.gear).toHaveLength(1);
  });

  it("翻页筛选，跳过锁定、穿戴、已挂单、魔法石和需验证码装备，按回收价选候选", async () => {
    const fixture = setup();
    fixture.pages.splice(0, 1,
      { gear: [
        { ...gear("locked"), isLocked: true }, { ...gear("worn"), equippedSlot: "gloves" },
        { ...gear("listed"), marketOrderId: "order-1" }, { ...gear("stone"), slot: "magic_stone" },
        { ...gear("exotic"), rarity: "exotic" }, { ...gear("arcane"), rarity: "arcane" },
        { ...gear("expensive"), sellValue: 100 },
      ], nextCursor: "1" },
      { gear: [gear("cheap")], nextCursor: null },
    );
    const response = await fixture.read();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ candidate: { id: "cheap" }, candidateCount: 2, scannedGearCount: 8 });
    expect(fixture.calls.some((c) => c.path === "/api/inventory/gear?cursor=1")).toBe(true);
  });

  it("余额不足和挂单已满仍展示预览，明确列出不满足条件", async () => {
    const fixture = setup();
    fixture.payer.gold = 10;
    fixture.config.activeOrderCount = 10;
    const response = await fixture.read();
    expect(response.status).toBe(200);
    expect(response.body.issues.join(" ")).toContain("金币不足");
    expect(response.body.issues.join(" ")).toContain("挂单数量已达上限");
    expect(response.body.grossGold).toBe(117);
  });

  it("低于最低售价时不擅自增加付款金额，也不生成装备候选", async () => {
    const fixture = setup();
    fixture.config.gearMinimumPrices[0]!.effectiveBaseMinimumUnitPrice = 1000;
    const response = await fixture.read();
    expect(response.body.candidate).toBeNull();
    expect(response.body.grossGold).toBe(117);
    expect(response.body.issues.join(" ")).toContain("最低售价");
  });

  it("空背包返回明确说明", async () => {
    const fixture = setup();
    fixture.pages[0]!.gear = [];
    const response = await fixture.read();
    expect(response.body.candidate).toBeNull();
    expect(response.body.issues.join(" ")).toContain("没有无需验证码");
  });

  it("拒绝相同记录和重复绑定的同一游戏角色", async () => {
    const fixture = setup();
    expect((await app.get(fixture.path(100, fixture.payerId, fixture.payerId), fixture.user.jar)).status).toBe(400);
    expect(fixture.calls).toHaveLength(0);
    fixture.receiver.id = fixture.payer.id;
    const response = await fixture.read();
    expect(response.status).toBe(400);
    expect((response.body as any).error.code).toBe("SAME_GAME_ACCOUNT");
    expect(fixture.calls).toHaveLength(2);
  });

  it("任一账号不属于自己时返回 404，不请求游戏", async () => {
    const fixture = setup();
    const other = app.seedApprovedUser(`other${seq}@example.com`);
    const foreignId = app.seedAccount(other.id);
    for (const path of [fixture.path(100, fixture.payerId, foreignId), fixture.path(100, foreignId, fixture.receiverId)]) {
      expect((await app.get(path, fixture.user.jar)).status).toBe(404);
    }
    expect(fixture.calls).toHaveLength(0);
  });

  it("未登录被拒绝，非法金额被拒绝，不执行游戏请求", async () => {
    const fixture = setup();
    expect((await app.get(fixture.path())).status).toBe(401);
    for (const amount of [0, -1, 1.5, "NaN", "Infinity", "9007199254740992"]) {
      expect((await app.get(fixture.path(amount), fixture.user.jar)).status).toBe(400);
    }
    expect(fixture.calls).toHaveLength(0);
  });

  it("市场权限不可用时停止读取并明确报错", async () => {
    const fixture = setup();
    fixture.receiver.canAccessMarket = false;
    const response = await fixture.read();
    expect(response.status).toBe(409);
    expect((response.body as any).error.code).toBe("MARKET_UNAVAILABLE");
    expect(fixture.calls).toHaveLength(2);
  });

  it("未审批用户不读取游戏数据", async () => {
    const fixture = setup();
    app.repos.users.setStatus(fixture.user.id, "pending");
    expect((await fixture.read()).status).toBe(403);
    expect(fixture.calls).toHaveLength(0);
  });

  it("游戏读取失败时展示具体原因，不伪造税率或余额", async () => {
    const fixture = setup();
    vi.mocked(app.registry.require(fixture.receiverId).client.request).mockRejectedValueOnce(new GameClientError("请求超时"));
    const response = await fixture.read();
    expect(response.status).toBe(502);
    expect((response.body as any).error.message).toContain("请求超时");
    expect((response.body as any).grossGold).toBeUndefined();
  });

  it("缺失保护字段或最低售价时不默认猜测数据", async () => {
    const fixture = setup();
    fixture.pages[0]!.gear = [{ ...gear(), isLocked: undefined }];
    expect((await fixture.read()).status).toBe(502);
    fixture.pages[0]!.gear = [gear()];
    fixture.config.gearMinimumPrices = [];
    const response = await fixture.read();
    expect(response.status).toBe(502);
    expect((response.body as any).error.code).toBe("GEAR_PRICE_UNKNOWN");
  });

  it("背包游标循环时停止，不把部分背包当完整结果", async () => {
    const fixture = setup();
    fixture.pages[0]!.nextCursor = "1";
    fixture.pages.push({ gear: [], nextCursor: "1" });
    const response = await fixture.read();
    expect(response.status).toBe(502);
    expect((response.body as any).error.code).toBe("INVENTORY_INCOMPLETE");
  });

  it("未提供成交或确认执行路由", async () => {
    const fixture = setup();
    expect((await app.post("/api/trade-preview", {}, fixture.user.jar)).status).toBe(404);
    expect((await app.post("/api/trade-preview/execute", {}, fixture.user.jar)).status).toBe(404);
    expect(fixture.calls).toHaveLength(0);
  });
});
