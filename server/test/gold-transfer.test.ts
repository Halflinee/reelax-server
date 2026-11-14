import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import type { TradePreview } from "../src/services/trade-preview-service.ts";
import { GoldTransferService, type GoldTransferView } from "../src/services/gold-transfer-service.ts";
import { GameClientError } from "../src/game/errors.ts";

let app: FullApp;
let seq = 0;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });

function setup() {
  const user = app.seedApprovedUser(`transfer${++seq}@example.com`);
  const payerId = app.seedAccount(user.id, "付款号");
  const receiverId = app.seedAccount(user.id, "收款号");
  const payer = { id: `payer-${seq}`, nickname: "付款角色", gold: 10000, canAccessMarket: true };
  const receiver = { id: `receiver-${seq}`, nickname: "收款角色", gold: 500, canAccessMarket: true };
  const gear = { id: `gear-${seq}`, name: "测试手套", rarity: "common", slot: "gloves", quality: 12, upgradeLevel: 0,
    sellValue: 10, isLocked: false, equippedSlot: null, marketOrderId: null as string | null };
  const config = { sellerFeeBasisPoints: 1500, activeOrderCount: 0, maxActiveOrdersPerPlayer: 10,
    gearMinimumPrices: [{ rarity: "common", effectiveBaseMinimumUnitPrice: 1 }] };
  const orderId = `order-${seq}`;
  type Trade = { id: string; role: string; quantity: number; gross: number; fee: number; sellerProceeds: number; asset: { type: string; gear: { id: string } } };
  const state = { listed: false, purchased: false, wrongOrderPrice: false, timeoutAfterPurchase: false,
    timeoutListing: false, malformedListing: false, thirdParty: false, noNewHistory: false, wrongNet: false,
    listingGate: null as Promise<void> | null,
    baselineGate: null as Promise<void> | null,
    payerTrades: [] as Trade[], receiverTrades: [] as Trade[] };
  const calls: { path: string; method: string; key?: string; body?: unknown; role: string }[] = [];
  for (const [id, role, player] of [[payerId, "payer", payer], [receiverId, "receiver", receiver]] as const) {
    vi.spyOn(app.registry.require(id).client, "request").mockImplementation(async (path, options = {}) => {
      const method = options.method ?? "GET";
      calls.push({ path, method, key: options.headers?.["Idempotency-Key"], body: options.body, role });
      if (method === "GET") {
        if (path === "/api/me") return { player };
        if (path === "/api/market/config") return config;
        if (path === "/api/inventory/gear") return { gear: state.purchased ? [] : [gear] };
        if (path.startsWith("/api/market/me/trades?")) { await state.baselineGate; return { trades: role === "payer" ? state.payerTrades : state.receiverTrades }; }
        if (path.startsWith("/api/market/me/orders?")) return { orders: state.listed ? [{ id: orderId, status: "active",
          limitUnitPrice: state.wrongOrderPrice ? 118 : 117, asset: { type: "gear", gear: { id: gear.id } } }] : [] };
      }
      if (method === "POST" && path === "/api/market/orders" && role === "receiver") {
        await state.listingGate;
        if (state.timeoutListing) throw new GameClientError("上架请求超时");
        state.listed = true; gear.marketOrderId = orderId;
        return state.malformedListing ? {} : { order: { id: orderId } };
      }
      if (method === "POST" && path === `/api/market/orders/${orderId}/purchase` && role === "payer") {
        if (state.thirdParty) throw new GameClientError("订单已被其他人购买");
        state.listed = false; state.purchased = true;
        payer.gold -= 117; receiver.gold += state.wrongNet ? 99 : 100;
        const trade = { id: `trade-${seq}`, quantity: 1, gross: 117, fee: state.wrongNet ? 18 : 17,
          sellerProceeds: state.wrongNet ? 99 : 100, asset: { type: "gear", gear: { id: gear.id } } };
        if (!state.noNewHistory) {
          state.payerTrades.unshift({ ...trade, role: "buyer" }); state.receiverTrades.unshift({ ...trade, role: "seller" });
        }
        if (state.timeoutAfterPurchase) throw new GameClientError("购买请求超时");
        return { order: { id: orderId }, player: payer };
      }
      throw new Error(`未知测试请求：${role} ${method} ${path}`);
    });
  }
  const prepare = async () => {
    const result = await app.get<TradePreview>(`/api/trade-preview?${new URLSearchParams({ payerAccountId: payerId, receiverAccountId: receiverId, amount: "100" })}`, user.jar);
    expect(result.status).toBe(200);
    expect(result.body.confirmation).toBeDefined();
    return result.body.confirmation!.id;
  };
  const confirm = (id: string) => app.post<GoldTransferView>(`/api/trade-preview/operations/${id}/confirm`, { confirmed: true }, user.jar);
  const settle = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await app.get<GoldTransferView>(`/api/trade-preview/operations/${id}`, user.jar);
      if (result.body.status !== "executing") return result.body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("交易测试未结束");
  };
  const writes = () => calls.filter((call) => call.method !== "GET");
  return { user, payerId, receiverId, payer, receiver, config, gear, orderId, state, calls, prepare, confirm, settle, writes };
}

describe("金币集中：确认、执行和核对", () => {
  it("预览不写入游戏；确认后才上架并购买指定订单，双方记录一致才完成", async () => {
    const f = setup();
    const id = await f.prepare();
    expect(f.writes()).toEqual([]);
    await f.confirm(id);
    const operation = await f.settle(id);
    expect(operation.status).toBe("completed");
    expect(operation.settlement).toMatchObject({ grossGold: 117, feeGold: 17, netGold: 100 });
    expect(f.payer.gold).toBe(9883); expect(f.receiver.gold).toBe(600);
    expect(f.writes().map((call) => [call.role, call.path])).toEqual([
      ["receiver", "/api/market/orders"], ["payer", `/api/market/orders/${f.orderId}/purchase`],
    ]);
    const saved = app.repos.goldTransfers.find(f.user.id, id)!;
    expect(f.writes().map((call) => call.key)).toEqual([saved.listingKey, saved.purchaseKey]);
    expect(saved.listingKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.purchaseKey).toMatch(/^[0-9a-f-]{36}$/);
    const history = await app.get<GoldTransferView[]>("/api/trade-preview/operations", f.user.jar);
    expect(history.body[0]!.id).toBe(id);
    expect((history.body[0] as any).listingKey).toBeUndefined();
    expect((history.body[0] as any).baseline).toBeUndefined();
  });

  it("同一确认重复或并发提交，也只交易一次", async () => {
    const f = setup(); const id = await f.prepare();
    await Promise.all([f.confirm(id), f.confirm(id), f.confirm(id)]);
    expect((await f.settle(id)).status).toBe("completed");
    await f.confirm(id);
    expect(f.writes()).toHaveLength(2);
    expect(app.db.get<{ n: number }>("SELECT count(*) AS n FROM audit_events WHERE action='account.gold_transfer.confirmed' AND target=?", id)!.n).toBe(1);
  });

  it("相关账号已在交易时，另一条确认记录不能并行执行", async () => {
    const f = setup(); const first = await f.prepare(); const second = await f.prepare();
    const gate = Promise.withResolvers<void>(); f.state.listingGate = gate.promise;
    await f.confirm(first);
    try { expect((await f.confirm(second)).status).toBe(409); }
    finally { gate.resolve(); }
    expect((await f.settle(first)).status).toBe("completed");
    expect(f.writes()).toHaveLength(2);
  });

  it("预览过期或未明确确认时不执行", async () => {
    const f = setup(); const id = await f.prepare();
    expect((await app.post(`/api/trade-preview/operations/${id}/confirm`, {}, f.user.jar)).status).toBe(400);
    expect((await app.post(`/api/trade-preview/operations/${id}/confirm`, { confirmed: true, amount: 999 }, f.user.jar)).status).toBe(400);
    app.db.run("UPDATE gold_transfers SET expires_at=0 WHERE id=?", id);
    expect((await f.confirm(id)).status).toBe(409);
    expect(f.writes()).toEqual([]);
  });

  it("准备期间用户被停用，不得继续发起游戏写操作", async () => {
    const f = setup(); const id = await f.prepare();
    const gate = Promise.withResolvers<void>(); f.state.baselineGate = gate.promise;
    await f.confirm(id);
    app.repos.users.setStatus(f.user.id, "banned");
    gate.resolve();
    await vi.waitFor(() => expect(app.repos.goldTransfers.find(f.user.id, id)!.status).toBe("failed"));
    expect(f.writes()).toEqual([]);
  });

  it("准备期间账号被删除，不得使用旧会话继续交易", async () => {
    const f = setup(); const id = await f.prepare();
    const gate = Promise.withResolvers<void>(); f.state.baselineGate = gate.promise;
    await f.confirm(id);
    app.db.run("DELETE FROM game_accounts WHERE id=?", f.receiverId);
    gate.resolve();
    await vi.waitFor(() => expect(app.repos.goldTransfers.find(f.user.id, id)!.status).toBe("failed"));
    expect(f.writes()).toEqual([]);
  });

  it("同一游戏角色被绑定到不同用户下，也不能并行执行金币交易", async () => {
    const first = setup(); const firstId = await first.prepare();
    app.repos.goldTransfers.claim(first.user.id, firstId);
    const second = setup(); second.payer.id = first.payer.id;
    const secondId = await second.prepare();
    expect((await second.confirm(secondId)).status).toBe(409);
    expect(second.writes()).toEqual([]);
  });

  it("其他用户不能读取、确认、核对或结束这条记录", async () => {
    const f = setup(); const id = await f.prepare();
    const other = app.seedApprovedUser(`foreign-transfer${seq}@example.com`);
    expect((await app.get(`/api/trade-preview/operations/${id}`, other.jar)).status).toBe(404);
    for (const action of ["confirm", "check", "close"]) {
      expect((await app.post(`/api/trade-preview/operations/${id}/${action}`, { confirmed: true }, other.jar)).status).toBe(404);
    }
    expect((await app.get<unknown[]>("/api/trade-preview/operations", other.jar)).body).toEqual([]);
    expect(f.writes()).toEqual([]);
  });

  it.each(["balance", "tax", "gear", "identity"])("确认前 %s 改变，不自动替换装备或金额", async (kind) => {
    const f = setup(); const id = await f.prepare();
    if (kind === "balance") f.payer.gold = 1;
    if (kind === "tax") f.config.sellerFeeBasisPoints = 1000;
    if (kind === "gear") f.gear.isLocked = true;
    if (kind === "identity") f.payer.id = "different-player";
    await f.confirm(id);
    expect((await f.settle(id)).status).toBe("failed");
    expect(f.writes()).toEqual([]);
  });

  it("上架后订单价格不符，不购买并保留订单号", async () => {
    const f = setup(); const id = await f.prepare(); f.state.wrongOrderPrice = true;
    await f.confirm(id);
    expect(await f.settle(id)).toMatchObject({ status: "review_required", orderId: f.orderId });
    expect(f.writes()).toHaveLength(1);
    await f.confirm(id);
    expect(f.writes()).toHaveLength(1);
  });

  it.each(["timeoutListing", "malformedListing"] as const)("上架响应不明确：%s，不重复上架也不购买", async (mode) => {
    const f = setup(); const id = await f.prepare(); f.state[mode] = true;
    await f.confirm(id);
    expect((await f.settle(id)).status).toBe("review_required");
    await f.confirm(id); expect(f.writes()).toHaveLength(1);
  });

  it("购买实际上成功但响应丢失时，仅核对记录就能完成，不再次扣款", async () => {
    const f = setup(); const id = await f.prepare(); f.state.timeoutAfterPurchase = true;
    await f.confirm(id);
    expect((await f.settle(id)).status).toBe("review_required");
    await f.confirm(id); expect(f.writes()).toHaveLength(2);
    const checked = await app.post<GoldTransferView>(`/api/trade-preview/operations/${id}/check`, {}, f.user.jar);
    expect(checked.body.status).toBe("completed");
    expect(f.writes()).toHaveLength(2);
    expect(f.payer.gold).toBe(9883);
  });

  it("挂单被其他人买走，不能把单方记录当成本次转账成功", async () => {
    const f = setup(); const id = await f.prepare(); f.state.thirdParty = true;
    await f.confirm(id);
    expect((await f.settle(id)).status).toBe("review_required");
    const checked = await app.post<GoldTransferView>(`/api/trade-preview/operations/${id}/check`, {}, f.user.jar);
    expect(checked.body.status).toBe("review_required");
    expect(f.payer.gold).toBe(10000);
    expect(f.writes()).toHaveLength(2);
  });

  it("历史上同一件装备的成交不能冒充本次新成交", async () => {
    const f = setup();
    const trade = { id: "old-trade", quantity: 1, gross: 117, fee: 17, sellerProceeds: 100, asset: { type: "gear", gear: { id: f.gear.id } } };
    f.state.payerTrades.push({ ...trade, role: "buyer" }); f.state.receiverTrades.push({ ...trade, role: "seller" });
    f.state.noNewHistory = true;
    const id = await f.prepare(); await f.confirm(id);
    expect((await f.settle(id)).status).toBe("review_required");
  });

  it("实际到账与预览不同，展示实际金额并阻止自动补转", async () => {
    const f = setup(); const id = await f.prepare(); f.state.wrongNet = true;
    await f.confirm(id);
    expect(await f.settle(id)).toMatchObject({ status: "review_required", settlement: { netGold: 99 } });
    await f.confirm(id); expect(f.writes()).toHaveLength(2);
  });

  it("重启后进行中的记录变为待核对，不自动恢复写操作", async () => {
    const f = setup(); const id = await f.prepare(); app.repos.goldTransfers.claim(f.user.id, id);
    const service = new GoldTransferService({ accounts: app.accounts, registry: app.registry, repos: app.repos });
    expect(service.get(f.user.id, id).status).toBe("review_required");
    expect(f.writes()).toEqual([]);
  });

  it("异常记录必须明确人工核对后才能结束，结束本身不交易", async () => {
    const f = setup(); const id = await f.prepare(); f.state.timeoutListing = true;
    await f.confirm(id); await f.settle(id);
    expect((await app.post(`/api/trade-preview/operations/${id}/close`, {}, f.user.jar)).status).toBe(400);
    const closed = await app.post<GoldTransferView>(`/api/trade-preview/operations/${id}/close`, { confirmed: true }, f.user.jar);
    expect(closed.body.status).toBe("closed");
    await f.confirm(id);
    expect(f.writes()).toHaveLength(1);
  });

  it("旧的待核对记录不会被最近十条已结束记录挤出界面", async () => {
    const f = setup(); const id = await f.prepare();
    app.repos.goldTransfers.update(f.user.id, id, "review_required", { message: "需要核对" });
    app.db.run("UPDATE gold_transfers SET created_at=0 WHERE id=?", id);
    const preview = app.repos.goldTransfers.find(f.user.id, id)!.preview;
    for (let count = 0; count < 11; count++) {
      const newer = app.repos.goldTransfers.create(f.user.id, preview);
      app.repos.goldTransfers.update(f.user.id, newer.id, "failed", { message: "测试结束记录" });
    }
    const history = await app.get<GoldTransferView[]>("/api/trade-preview/operations", f.user.jar);
    expect(history.body[0]!.id).toBe(id);
    expect(history.body).toHaveLength(11);
  });
});
