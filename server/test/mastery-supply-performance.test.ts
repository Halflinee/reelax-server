import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { MasterySupplyService } from "../src/services/mastery-supply-service.ts";

let app: FullApp; let sequence = 0;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
afterEach(() => { vi.useRealTimers(); });

function fixture(sourceCount = 3) {
  const user = app.seedApprovedUser(`supply-performance-${++sequence}@example.com`);
  const targetId = app.seedAccount(user.id, "需求账号");
  const sourceIds = Array.from({ length: sourceCount }, (_, index) => app.seedAccount(user.id, `供给${index}`));
  const calls: string[] = [];
  const controls = { balance: 10000, stock: 10, slowAccountId: "" };
  for (const id of [targetId, ...sourceIds]) {
    vi.spyOn(app.registry.require(id).client, "request").mockImplementation(async (path) => {
      calls.push(`${id}:${path}`);
      await new Promise((resolve) => setTimeout(resolve, controls.slowAccountId === id ? 300 : 100));
      if (path === "/api/me") return { player: { id, nickname: id, gold: controls.balance, canAccessMarket: true } };
      if (path === "/api/mastery") return { biomes: [{ biomeId: "map", isUnlocked: true, rarities: [{ rarity: "common", fish: { id: "fish" }, remainingQuantity: 5, availableQuantity: 0 }] }] };
      if (path === "/api/inventory/fish") return { fish: [{ fishId: "fish", quantity: id === targetId ? 1 : controls.stock, isLocked: false }] };
      if (path === "/api/content/bootstrap") return { biomes: [{ id: "map", name: "地图" }], fish: [{ id: "fish", name: "鱼", rarity: "common", biomeId: "map", sellPrice: 100 }] };
      if (path === "/api/market/config") return { sellerFeeBasisPoints: 500, maxFishOrderQuantity: 100, activeOrderCount: 0, maxActiveOrdersPerPlayer: 10, fishMinimumPrices: [] };
      if (path.includes("/order-book?")) return { version: 1, buyLevels: [], sellLevels: [] };
      throw new Error(`不应请求 ${path}`);
    });
  }
  const service = new MasterySupplyService({ accounts: app.accounts, registry: app.registry });
  return { user, service, calls, controls, sourceIds, input: { targetAccountId: targetId, sourceAccountId: sourceIds[0]!, biomeId: "map", fishId: "fish", quantity: 3, unitPrice: 100 } };
}

async function measure<T>(run: () => Promise<T>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const start = Date.now(); let elapsed = -1;
  const result = run().then((data) => { elapsed = Date.now() - start; return data; });
  await vi.advanceTimersByTimeAsync(1000);
  return { data: await result, elapsed };
}

describe("专精鱼真实服务路径的模拟网络延迟", () => {
  it("供需读取不把需求方、市场配置和供给方排成三轮等待", async () => {
    const f = fixture();
    const result = await measure(() => f.service.preview(f.user.id, f.input));
    expect(result.data.suppliers).toHaveLength(3);
    expect(result.elapsed, "每个游戏请求 100ms 时，独立读取应一轮完成").toBeLessThanOrEqual(100);
  });
  it("两账号交易预览不重复经过四轮网络往返", async () => {
    const f = fixture();
    const result = await measure(() => f.service.quote(f.user.id, f.input));
    expect(result.data.issues).toEqual([]);
    expect(result.elapsed, "每个游戏请求 100ms 时，交易预览应一轮完成").toBeLessThanOrEqual(100);
    const requestedIds = new Set(f.calls.map((call) => call.split(":")[0]));
    expect(requestedIds).toEqual(new Set([f.input.targetAccountId, f.input.sourceAccountId]));
    expect(f.calls.filter((call) => call.endsWith(":/api/me"))).toHaveLength(2);
    expect(f.calls.filter((call) => call.endsWith(":/api/market/config"))).toHaveLength(2);
  });
  it("一个慢账号不阻塞空闲位置继续读取其他账号", async () => {
    const f = fixture(5); f.controls.slowAccountId = f.sourceIds[0]!;
    const result = await measure(() => f.service.preview(f.user.id, f.input));
    expect(result.data.suppliers).toHaveLength(5);
    expect(result.elapsed).toBe(300);
  });
  it("加速后仍重新读取余额和库存，不拿上一笔快照生成交易报价", async () => {
    const f = fixture();
    expect((await measure(() => f.service.quote(f.user.id, f.input))).data.issues).toEqual([]);
    f.controls.balance = 1; f.controls.stock = 5;
    const changed = await measure(() => f.service.quote(f.user.id, f.input));
    expect(changed.data.issues.join(" ")).toContain("金币不足");
    expect(changed.data.issues.join(" ")).toContain("可出售余量");
  });
});
