import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFullApp, type FullApp } from "./helpers/full-app.ts";
import { MasterySupplyService } from "../src/services/mastery-supply-service.ts";
import { GameClientError, GAME_ERROR_CODES } from "../src/game/errors.ts";

let app: FullApp; let sequence = 0;
beforeAll(async () => { app = await buildFullApp(); });
afterAll(async () => { await app.close(); });
afterEach(() => { vi.useRealTimers(); });

function fixture(sourceCount = 3) {
  const user = app.seedApprovedUser(`supply-performance-${++sequence}@example.com`);
  const targetId = app.seedAccount(user.id, "需求账号");
  const sourceIds = Array.from({ length: sourceCount }, (_, index) => app.seedAccount(user.id, `供给${index}`));
  for (const id of [targetId, ...sourceIds]) app.repos.accounts.update(id, user.id, { baseUrl: `https://perf-${sequence}.example` });
  const calls: string[] = [];
  const controls = { balance: 10000, stock: 10, slowAccountId: "", failCatalog: false, failPath: "" };
  for (const id of [targetId, ...sourceIds]) {
    vi.spyOn(app.registry.require(id).client, "request").mockImplementation(async (path) => {
      calls.push(`${id}:${path}`);
      await new Promise((resolve) => setTimeout(resolve, controls.slowAccountId === id ? 300 : 100));
      if (path === controls.failPath || (path === "/api/content/bootstrap" && controls.failCatalog)) throw new GameClientError("请求超时（30000ms）", { code: GAME_ERROR_CODES.TIMEOUT });
      if (path === "/api/me") return { player: { id, nickname: id, gold: controls.balance, canAccessMarket: true } };
      if (path === "/api/mastery") return { biomes: [{ biomeId: "map", isUnlocked: true, rarities: [{ rarity: "common", fish: { id: "fish" }, remainingQuantity: 5, availableQuantity: 0 }] }] };
      if (path === "/api/inventory/fish") return { fish: [{ fishId: "fish", quantity: id === targetId ? 1 : controls.stock, isLocked: false }] };
      if (path === "/api/content/bootstrap") return { biomes: [{ id: "map", name: "地图" }], fish: [{ id: "fish", name: "鱼", rarity: "common", biomeId: "map", sellPrice: 100 }] };
      if (path === "/api/market/config") return { sellerFeeBasisPoints: 500, maxFishOrderQuantity: 100, activeOrderCount: 0, maxActiveOrdersPerPlayer: 10, fishMinimumPrices: [] };
      if (path.includes("/order-book?")) return { version: 1, buyLevels: [], sellLevels: [] };
      throw new Error(`不应请求 ${path}`);
    });
  }
  const service = new MasterySupplyService({ accounts: app.accounts, registry: app.registry, repos: app.repos });
  return { user, service, calls, controls, sourceIds, input: { targetAccountId: targetId, sourceAccountId: sourceIds[0]!, biomeId: "map", fishId: "fish", quantity: 3, unitPrice: 100 } };
}

async function measure<T>(run: () => Promise<T>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const start = Date.now(); let elapsed = -1;
  const result = run().then((data) => { elapsed = Date.now() - start; return { data }; }, (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(1000);
  const outcome = await result;
  if ("error" in outcome) throw outcome.error;
  return { data: outcome.data, elapsed };
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
  it("已读取地图后，生成供需和报价不再重复下载大份公共资料", async () => {
    const f = fixture();
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    f.controls.failCatalog = true;
    const supply = await measure(() => f.service.preview(f.user.id, f.input));
    expect(supply.data.suppliers).toHaveLength(3);
    expect((await measure(() => f.service.quote(f.user.id, f.input))).data.issues).toEqual([]);
    expect(f.calls.filter((call) => call.endsWith(":/api/content/bootstrap"))).toHaveLength(1);
  });
  it("超时能指出具体账号和接口，而不是只显示笼统的 30000ms", async () => {
    const f = fixture(); f.controls.failPath = "/api/mastery";
    await expect(measure(() => f.service.options(f.user.id, f.input.targetAccountId))).rejects.toThrow(/需求账号.*专精目标.*30000ms/);
  });
  it("并发读取同一游戏公共资料只下载一次，个人数据仍按账号分别读取", async () => {
    const f = fixture();
    const results = await measure(() => Promise.all([
      f.service.options(f.user.id, f.input.targetAccountId), f.service.options(f.user.id, f.sourceIds[0]!),
    ]));
    expect(f.calls.filter((call) => call.endsWith(":/api/content/bootstrap"))).toHaveLength(1);
    expect(results.data[0]!.target.accountId).toBe(f.input.targetAccountId);
    expect(results.data[1]!.target.accountId).toBe(f.sourceIds[0]);
  });
  it("固定资料不会因时间自动失效，手动更新失败保留旧资料", async () => {
    const f = fixture();
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    f.controls.failCatalog = true;
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    expect(f.calls.filter((call) => call.endsWith(":/api/content/bootstrap"))).toHaveLength(1);
    await expect(measure(() => f.service.refreshCatalog(f.user.id, f.input.targetAccountId))).rejects.toThrow(/公共鱼种和地图资料.*30000ms/);
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    f.controls.failCatalog = false;
    await measure(() => f.service.refreshCatalog(f.user.id, f.input.targetAccountId));
    expect(f.calls.filter((call) => call.endsWith(":/api/content/bootstrap"))).toHaveLength(3);
  });
  it("不同游戏服务器不共享公共资料", async () => {
    const f = fixture();
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    app.repos.accounts.update(f.sourceIds[0]!, f.user.id, { baseUrl: "https://another-game.example" });
    await measure(() => f.service.options(f.user.id, f.sourceIds[0]!));
    expect(f.calls.filter((call) => call.endsWith(":/api/content/bootstrap"))).toHaveLength(2);
  });
  it("交易复查仍刷新个人数据，但不重新下载固定资料", async () => {
    const f = fixture();
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    f.controls.failCatalog = true;
    expect((await measure(() => f.service.quote(f.user.id, f.input))).data.issues).toEqual([]);
    expect(f.calls.filter((call) => call.endsWith(":/api/content/bootstrap"))).toHaveLength(1);
  });
  it("不同用户的并发下载失败不能带出对方账号名称", async () => {
    const first = fixture(); const second = fixture();
    app.repos.accounts.update(second.input.targetAccountId, second.user.id, { label: "另一个用户的账号", baseUrl: app.accounts.getForUser(first.input.targetAccountId, first.user.id).baseUrl });
    first.controls.failCatalog = true; second.controls.failCatalog = true;
    const result = await measure(() => Promise.allSettled([
      first.service.options(first.user.id, first.input.targetAccountId), first.service.options(second.user.id, second.input.targetAccountId),
    ]));
    const failures = result.data.map((entry) => entry.status === "rejected" ? String(entry.reason.message) : "没有报错");
    expect(failures[0]).toContain("需求账号");
    expect(failures[1]).toContain("另一个用户的账号");
    expect(failures[1]).not.toContain("需求账号");
  });
  it("重建服务后读取本地固定资料，不依赖之前实例的内存", async () => {
    const f = fixture();
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    f.controls.failCatalog = true;
    const restarted = new MasterySupplyService({ accounts: app.accounts, registry: app.registry, repos: app.repos });
    expect((await measure(() => restarted.options(f.user.id, f.input.targetAccountId))).data.biomes[0]!.name).toBe("地图");
    expect(f.calls.filter((call) => call.endsWith(":/api/content/bootstrap"))).toHaveLength(1);
  });
  it("本地只保存已验证的公开资料，手动更新能替换名称而不保存额外字段", async () => {
    const f = fixture();
    const replacement = { biomes: [{ id: "map", name: "新版地图" }], fish: [{ id: "fish", name: "新版鱼名", rarity: "common", biomeId: "map", sellPrice: 100 }], privateToken: "must-not-persist" };
    vi.spyOn(app.registry.require(f.input.targetAccountId).client, "contentBootstrap").mockResolvedValueOnce(replacement);
    await measure(() => f.service.refreshCatalog(f.user.id, f.input.targetAccountId));
    const result = await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    expect(result.data.biomes[0]!.name).toBe("新版地图");
    expect(result.data.biomes[0]!.fish[0]!.name).toBe("新版鱼名");
    const stored = app.repos.gameCatalogs.find(app.accounts.getForUser(f.input.targetAccountId, f.user.id).baseUrl)!;
    expect(stored.content_json).not.toContain("privateToken"); expect(stored.content_json).not.toContain("must-not-persist");
  });
  it("不完整的更新不覆盖旧资料，损坏的本地资料需要明确更新才能恢复", async () => {
    const f = fixture();
    await measure(() => f.service.options(f.user.id, f.input.targetAccountId));
    const url = app.accounts.getForUser(f.input.targetAccountId, f.user.id).baseUrl;
    const before = app.repos.gameCatalogs.find(url)!.content_json;
    vi.spyOn(app.registry.require(f.input.targetAccountId).client, "contentBootstrap").mockResolvedValueOnce({ fish: [], biomes: [] });
    await expect(measure(() => f.service.refreshCatalog(f.user.id, f.input.targetAccountId))).rejects.toThrow("固定资料不完整");
    expect(app.repos.gameCatalogs.find(url)!.content_json).toBe(before);
    app.repos.gameCatalogs.save(url, "broken json");
    await expect(measure(() => f.service.options(f.user.id, f.input.targetAccountId))).rejects.toThrow("更新固定资料");
    await measure(() => f.service.refreshCatalog(f.user.id, f.input.targetAccountId));
    expect((await measure(() => f.service.options(f.user.id, f.input.targetAccountId))).data.biomes).toHaveLength(1);
  });
});
