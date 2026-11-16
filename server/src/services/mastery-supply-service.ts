import { z } from "zod";
import { HttpError } from "../api/server.ts";
import type { AccountService, AccountView } from "./account-service.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import { masteryCatalogSchema, masteryProfileSchema, readMasterySnapshot } from "./mastery-transfer-preview.ts";
import { rarityLabel } from "../modules/shared/rarity.ts";
import { GameClientError } from "../game/errors.ts";
import type { Repos } from "../db/repositories/index.ts";

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = amount.positive();
const staticCatalogSchema = masteryCatalogSchema.refine((data) => data.fish.length > 0 && data.biomes.length > 0);
export const fishMarketConfigSchema = z.object({
  sellerFeeBasisPoints: amount.max(10000), maxFishOrderQuantity: positive,
  activeOrderCount: amount, maxActiveOrdersPerPlayer: amount,
  fishMinimumPrices: z.array(z.object({ biomeId: z.string(), rarity: z.string(), configuredMinimumUnitPrice: amount.nullable() })),
});
export const fishBookSchema = z.object({ version: amount,
  buyLevels: z.array(z.object({ unitPrice: positive, quantity: positive })).max(50),
  sellLevels: z.array(z.object({ unitPrice: positive, quantity: positive })).max(50),
});
export function marketRead<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(502, "FISH_MARKET_DATA_INVALID", "游戏数据不完整或格式变化，无法可靠核对专精鱼交易。");
  return result.data;
}
export type FishActor = { accountId: string; playerId: string; label: string; nickname: string; gold: number; canAccessMarket: boolean };
export type FishSelection = { targetAccountId: string; biomeId: string; fishId: string };
export type FishQuoteInput = FishSelection & { sourceAccountId: string; quantity: number; unitPrice: number };
export type FishDefinition = { id: string; name: string; biomeId: string; biomeName: string; rarity: string; rarityLabel: string; sellPrice: number };
export type FishSupplier = { accountId: string; label: string; nickname: string | null; playerId: string | null;
  owned: number | null; reserved: number | null; protected: number | null; canProvide: number | null; issue: string | null };
export type MasteryDemandOptions = { createdAt: number; target: FishActor;
  biomes: { id: string; name: string; fish: { id: string; name: string; rarityLabel: string; missing: number }[] }[] };
export type MasterySupplyPreview = { createdAt: number; target: FishActor; fish: FishDefinition; targetMissing: number;
  market: { minimumUnitPrice: number; maxOrderQuantity: number; feeBasisPoints: number } | null; suppliers: FishSupplier[] };
export type FishTradeQuote = { createdAt: number; baseUrl: string; target: FishActor; source: FishActor; fish: FishDefinition;
  targetMissing: number; sourceCanProvide: number; quantity: number; unitPrice: number; grossGold: number;
  feeBasisPoints: number; feeGold: number; netGold: number; issues: string[]; confirmation?: { id: string; expiresAt: number } };

function priceFloor(config: z.infer<typeof fishMarketConfigSchema>, fish: FishDefinition) {
  const configured = config.fishMinimumPrices.find((entry) => entry.biomeId === fish.biomeId && entry.rarity === fish.rarity);
  return Math.max(fish.sellPrice, configured?.configuredMinimumUnitPrice ?? fish.sellPrice, 1);
}
/** 只有没有其他可成交买卖盘时才尝试配对；这不是撮合锁，也不能阻止之后出现新委托。 */
export function checkFishBook(raw: unknown, price: number, ownBuyQuantity = 0): void {
  const book = marketRead(fishBookSchema, raw);
  const buys = book.buyLevels.filter((level) => level.unitPrice >= price);
  if (book.sellLevels.some((level) => level.unitPrice <= price)
    || (ownBuyQuantity === 0 ? buys.length > 0 : buys.length !== 1 || buys[0]!.unitPrice !== price || buys[0]!.quantity !== ownBuyQuantity)) {
    throw new HttpError(409, "COMPETING_FISH_ORDERS", "盘口存在其他可成交订单或本次买单已变化，已停止；不能保证所选双方成交。");
  }
}

export class MasterySupplyService {
  private deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos };
  // 固定资料保存在现有数据卷的数据库中；个人数据始终实时读取。
  private catalogLoads = new Map<string, Promise<z.infer<typeof masteryCatalogSchema>>>();
  constructor(deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos }) { this.deps = deps; }
  private async readGame<T>(account: AccountView, resource: string, run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof GameClientError) throw new GameClientError(`${account.label}：读取${resource}失败，${error.message}`, { status: error.status, code: error.code });
      throw error;
    }
  }
  private async catalog(userId: string, account: AccountView, fresh: boolean) {
    const key = account.baseUrl;
    // 成功资料是公开内容；尚未完成的请求含账号和代理相关错误，按用户隔离。
    const loadingKey = JSON.stringify([userId, key]);
    if (!fresh) {
      const cached = this.deps.repos.gameCatalogs.find(key);
      if (cached) {
        try { return staticCatalogSchema.parse(JSON.parse(cached.content_json)); } catch {
          throw new HttpError(502, "LOCAL_CATALOG_INVALID", "本地固定资料损坏或格式已变化，请点击「更新固定资料」重新下载。");
        }
      }
      const loading = this.catalogLoads.get(loadingKey);
      if (loading) return loading;
    }
    const load = async () => {
      const client = this.deps.registry.require(account.id).client;
      const raw = await this.readGame(account, "公共鱼种和地图资料", () => client.contentBootstrap());
      const parsed = staticCatalogSchema.safeParse(raw);
      if (!parsed.success) throw new HttpError(502, "STATIC_CATALOG_INVALID", "游戏返回的固定资料不完整，未保存；请稍后重新更新。");
      const data = parsed.data;
      this.deps.repos.gameCatalogs.save(key, JSON.stringify(data));
      return data;
    };
    // 只有用户主动更新固定资料时才强制重新下载；正常预览和确认都使用本地资料。
    if (fresh) return load();
    const pending = load().finally(() => { if (this.catalogLoads.get(loadingKey) === pending) this.catalogLoads.delete(loadingKey); });
    this.catalogLoads.set(loadingKey, pending);
    return pending;
  }
  async refreshCatalog(userId: string, targetId: string) {
    const account = this.deps.accounts.getForUser(targetId, userId);
    const data = await this.catalog(userId, account, true);
    return { fishCount: data.fish.length, biomeCount: data.biomes.length };
  }
  private async accountContext(userId: string, accountId: string) {
    const account = this.deps.accounts.getForUser(accountId, userId);
    const client = this.deps.registry.require(accountId).client;
    const [profile, mastery, inventory] = await Promise.all([
      this.readGame(account, "账号资料", () => client.me()), this.readGame(account, "专精目标", () => client.mastery()),
      this.readGame(account, "鱼获背包", () => client.inventoryFish()),
    ]);
    return { account, client, player: marketRead(masteryProfileSchema, profile).player, snapshot: readMasterySnapshot(mastery, inventory) };
  }
  private actor(context: Awaited<ReturnType<MasterySupplyService["accountContext"]>>): FishActor {
    const { account, player } = context;
    if (player.gold === undefined) throw new HttpError(502, "GAME_DATA_INVALID", "账号金币数据缺失。");
    return { accountId: account.id, label: account.label, playerId: player.id, nickname: player.nickname, gold: player.gold, canAccessMarket: player.canAccessMarket };
  }
  private async targetContext(userId: string, targetId: string) {
    const account = this.deps.accounts.getForUser(targetId, userId);
    const [context, catalog] = await Promise.all([this.accountContext(userId, targetId), this.catalog(userId, account, false)]);
    return { ...context, target: this.actor(context), catalog };
  }
  private supplier(context: Awaited<ReturnType<MasterySupplyService["accountContext"]>>, targetPlayerId: string, fishId: string): FishSupplier {
    const { account, player, snapshot } = context;
    const row: FishSupplier = { accountId: account.id, label: account.label, nickname: player.nickname, playerId: player.id,
      owned: null, reserved: null, protected: null, canProvide: null, issue: null };
    if (player.id === targetPlayerId) return { ...row, issue: "这条记录登录的是需求账号本身。" };
    const stock = snapshot.stocks.get(fishId);
    return { ...row, owned: stock?.owned ?? 0, reserved: stock?.reserved ?? 0, protected: stock?.protected ?? 0,
      canProvide: player.canAccessMarket ? stock?.spare ?? 0 : 0, issue: player.canAccessMarket ? null : "该账号尚不能使用市场。" };
  }
  private definitions(context: Awaited<ReturnType<MasterySupplyService["targetContext"]>>) {
    return [...context.snapshot.missing].map(([id, missing]) => {
      const fish = context.catalog.fish.find((entry) => entry.id === id);
      const biome = context.catalog.biomes.find((entry) => entry.id === fish?.biomeId);
      if (!fish || !biome) throw new HttpError(502, "FISH_DATA_UNKNOWN", "本地固定资料未包含当前专精鱼或地图，请点击「更新固定资料」。");
      return { fish: { ...fish, biomeName: biome.name, rarityLabel: rarityLabel(fish.rarity) }, missing };
    });
  }
  async options(userId: string, targetId: string): Promise<MasteryDemandOptions> {
    const context = await this.targetContext(userId, targetId);
    const definitions = this.definitions(context);
    return { createdAt: Date.now(), target: context.target, biomes: context.catalog.biomes.map((biome) => ({ ...biome,
      fish: definitions.filter((entry) => entry.fish.biomeId === biome.id).map(({ fish, missing }) => ({ id: fish.id, name: fish.name, rarityLabel: fish.rarityLabel, missing })),
    })).filter((biome) => biome.fish.length > 0) };
  }
  async preview(userId: string, input: FishSelection, onlySourceId?: string): Promise<MasterySupplyPreview> {
    if (onlySourceId) this.deps.accounts.getForUser(onlySourceId, userId);
    const targetAccount = this.deps.accounts.getForUser(input.targetAccountId, userId);
    const targetClient = this.deps.registry.require(targetAccount.id).client;
    const accounts = this.deps.accounts.listForUser(userId).filter((account) => account.id !== input.targetAccountId && (!onlySourceId || account.id === onlySourceId));
    const targetPromise = this.targetContext(userId, input.targetAccountId);
    // 配置与账号独立读取；若账号没有市场权限，明确展示市场不可用。
    const configPromise = this.readGame(targetAccount, "市场配置", () => targetClient.marketConfig()).then((data: unknown) => ({ data }), (error: unknown) => ({ error }));
    const suppliers: FishSupplier[] = new Array(accounts.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < accounts.length) {
        const index = nextIndex++; const account: AccountView = accounts[index]!;
        const row: FishSupplier = { accountId: account.id, label: account.label, nickname: null, playerId: null,
          owned: null, reserved: null, protected: null, canProvide: null, issue: null };
        if (account.baseUrl !== targetAccount.baseUrl) { suppliers[index] = { ...row, issue: "账号属于其他游戏服务器。" }; continue; }
        try {
          const source = await this.accountContext(userId, account.id);
          const target = await targetPromise;
          suppliers[index] = this.supplier(source, target.target.playerId, input.fishId);
        } catch (error) { suppliers[index] = { ...row, issue: `读取失败：${error instanceof Error ? error.message : "未知错误"}` }; }
      }
    };
    // 始终最多并行三个供给账号；某个账号慢时，空闲位置继续读取后面的账号。
    const [context, configResult] = await Promise.all([targetPromise, configPromise,
      Promise.all(Array.from({ length: Math.min(3, accounts.length) }, () => worker())),
    ]);
    const selected = this.definitions(context).find((entry) => entry.fish.id === input.fishId && entry.fish.biomeId === input.biomeId);
    if (!selected) throw new HttpError(409, "MASTERY_TARGET_CHANGED", "所选地图或专精鱼已不在当前目标中，请重新选择。");
    let config: z.infer<typeof fishMarketConfigSchema> | null = null;
    if (context.target.canAccessMarket) {
      if ("error" in configResult) throw configResult.error;
      config = marketRead(fishMarketConfigSchema, configResult.data);
    }
    return { createdAt: Date.now(), target: context.target, fish: selected.fish, targetMissing: selected.missing,
      market: config ? { minimumUnitPrice: priceFloor(config, selected.fish), maxOrderQuantity: config.maxFishOrderQuantity, feeBasisPoints: config.sellerFeeBasisPoints } : null,
      suppliers: suppliers.sort((a, b) => (b.canProvide ?? -1) - (a.canProvide ?? -1)) };
  }
  async quote(userId: string, input: FishQuoteInput): Promise<FishTradeQuote> {
    const sourceAccount = this.deps.accounts.getForUser(input.sourceAccountId, userId);
    const targetAccount = this.deps.accounts.getForUser(input.targetAccountId, userId);
    if (sourceAccount.id === targetAccount.id) throw new HttpError(400, "SAME_ACCOUNT", "需求与供给不能是同一个账号。");
    if (sourceAccount.baseUrl !== targetAccount.baseUrl) throw new HttpError(400, "DIFFERENT_GAME_SERVER", "两个账号必须属于同一个游戏服务器。");
    const sourceClient = this.deps.registry.require(sourceAccount.id).client;
    const targetClient = this.deps.registry.require(targetAccount.id).client;
    // 报价只读取选中的两号；所有独立接口同轮发起，每份账号快照和市场配置只读一次。
    const [context, sourceContext, sourceRawConfig, targetRawConfig, book] = await Promise.all([
      this.targetContext(userId, targetAccount.id), this.accountContext(userId, sourceAccount.id),
      this.readGame(sourceAccount, "市场配置", () => sourceClient.marketConfig()), this.readGame(targetAccount, "市场配置", () => targetClient.marketConfig()),
      this.readGame(targetAccount, "鱼类盘口", () => targetClient.marketFishOrderBook(input.fishId)),
    ]);
    const selected = this.definitions(context).find((entry) => entry.fish.id === input.fishId && entry.fish.biomeId === input.biomeId);
    if (!selected) throw new HttpError(409, "MASTERY_TARGET_CHANGED", "所选地图或专精鱼已不在当前目标中，请重新选择。");
    const supplier = this.supplier(sourceContext, context.target.playerId, input.fishId);
    if (supplier.issue || supplier.canProvide === null) throw new HttpError(409, "SOURCE_UNAVAILABLE", supplier.issue ?? "供给账号不可用。");
    const source = this.actor(sourceContext);
    const supply = { target: context.target, fish: selected.fish, targetMissing: selected.missing };
    const sourceConfig = marketRead(fishMarketConfigSchema, sourceRawConfig);
    const targetConfig = marketRead(fishMarketConfigSchema, targetRawConfig);
    const minimumPrice = Math.max(priceFloor(sourceConfig, supply.fish), priceFloor(targetConfig, supply.fish));
    const issues: string[] = [];
    if (!supply.target.canAccessMarket) issues.push("需求账号尚不能使用市场。");
    if (input.unitPrice < minimumPrice) issues.push(`单价不能低于 ${minimumPrice} 金币。`);
    if (input.quantity > supply.targetMissing) issues.push("数量超过需求账号当前专精缺口。");
    if (input.quantity > supplier.canProvide) issues.push("数量超过供给账号可出售余量。");
    if (input.quantity > Math.min(sourceConfig.maxFishOrderQuantity, targetConfig.maxFishOrderQuantity)) issues.push("数量超过市场单笔上限。");
    if (sourceConfig.activeOrderCount >= sourceConfig.maxActiveOrdersPerPlayer || targetConfig.activeOrderCount >= targetConfig.maxActiveOrdersPerPlayer) issues.push("至少一个账号的市场挂单额度已满。");
    const gross = BigInt(input.quantity) * BigInt(input.unitPrice);
    if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(400, "AMOUNT_TOO_LARGE", "交易总金额过大。");
    const grossGold = Number(gross);
    if (grossGold > supply.target.gold) issues.push("需求账号金币不足。");
    try { checkFishBook(book, input.unitPrice); } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "COMPETING_FISH_ORDERS") throw error;
      issues.push(error.message);
    }
    const feeGold = Number(gross * BigInt(sourceConfig.sellerFeeBasisPoints) / 10000n);
    return { createdAt: Date.now(), baseUrl: targetAccount.baseUrl, target: supply.target, source, fish: supply.fish,
      targetMissing: supply.targetMissing, sourceCanProvide: supplier.canProvide, quantity: input.quantity, unitPrice: input.unitPrice,
      grossGold, feeBasisPoints: sourceConfig.sellerFeeBasisPoints, feeGold, netGold: grossGold - feeGold, issues };
  }
}
