import { z } from "zod";
import { HttpError } from "../api/server.ts";
import type { AccountService } from "./account-service.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import { masteryCatalogSchema, masteryProfileSchema, readMasterySnapshot } from "./mastery-transfer-preview.ts";
import { rarityLabel } from "../modules/shared/rarity.ts";

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = amount.positive();
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
  private deps: { accounts: AccountService; registry: RunnerRegistry };
  constructor(deps: { accounts: AccountService; registry: RunnerRegistry }) { this.deps = deps; }
  private async targetContext(userId: string, targetId: string) {
    const account = this.deps.accounts.getForUser(targetId, userId);
    const client = this.deps.registry.require(targetId).client;
    const [profile, mastery, inventory, rawCatalog] = await Promise.all([client.me(), client.mastery(), client.inventoryFish(), client.contentBootstrap()]);
    const player = marketRead(masteryProfileSchema, profile).player;
    if (player.gold === undefined) throw new HttpError(502, "GAME_DATA_INVALID", "需求账号金币数据缺失。");
    const target: FishActor = { accountId: account.id, label: account.label, playerId: player.id, nickname: player.nickname, gold: player.gold, canAccessMarket: player.canAccessMarket };
    return { account, client, target, snapshot: readMasterySnapshot(mastery, inventory), catalog: marketRead(masteryCatalogSchema, rawCatalog) };
  }
  private definitions(context: Awaited<ReturnType<MasterySupplyService["targetContext"]>>) {
    return [...context.snapshot.missing].map(([id, missing]) => {
      const fish = context.catalog.fish.find((entry) => entry.id === id);
      const biome = context.catalog.biomes.find((entry) => entry.id === fish?.biomeId);
      if (!fish || !biome) throw new HttpError(502, "FISH_DATA_UNKNOWN", "专精目标与鱼类资料不一致，请重新读取。");
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
    // 单个供给方报价也必须先校验归属，不能先读取别人的游戏数据。
    if (onlySourceId) this.deps.accounts.getForUser(onlySourceId, userId);
    const context = await this.targetContext(userId, input.targetAccountId);
    const selected = this.definitions(context).find((entry) => entry.fish.id === input.fishId && entry.fish.biomeId === input.biomeId);
    if (!selected) throw new HttpError(409, "MASTERY_TARGET_CHANGED", "所选地图或专精鱼已不在当前目标中，请重新选择。");
    const config = context.target.canAccessMarket ? marketRead(fishMarketConfigSchema, await context.client.marketConfig()) : null;
    const accounts = this.deps.accounts.listForUser(userId).filter((account) => account.id !== input.targetAccountId && (!onlySourceId || account.id === onlySourceId));
    const suppliers: FishSupplier[] = [];
    // 每批最多读取三个账号，避免账号较多时同时冲击游戏接口。
    for (let start = 0; start < accounts.length; start += 3) {
      suppliers.push(...await Promise.all(accounts.slice(start, start + 3).map(async (account): Promise<FishSupplier> => {
        const row: FishSupplier = { accountId: account.id, label: account.label, nickname: null, playerId: null,
          owned: null, reserved: null, protected: null, canProvide: null, issue: null };
        if (account.baseUrl !== context.account.baseUrl) return { ...row, issue: "账号属于其他游戏服务器。" };
        try {
          const client = this.deps.registry.require(account.id).client;
          const [rawProfile, mastery, inventory] = await Promise.all([client.me(), client.mastery(), client.inventoryFish()]);
          const player = marketRead(masteryProfileSchema, rawProfile).player;
          row.nickname = player.nickname; row.playerId = player.id;
          if (player.id === context.target.playerId) return { ...row, issue: "这条记录登录的是需求账号本身。" };
          const stock = readMasterySnapshot(mastery, inventory).stocks.get(input.fishId);
          return { ...row, owned: stock?.owned ?? 0, reserved: stock?.reserved ?? 0, protected: stock?.protected ?? 0,
            canProvide: player.canAccessMarket ? stock?.spare ?? 0 : 0, issue: player.canAccessMarket ? null : "该账号尚不能使用市场。" };
        } catch (error) { return { ...row, issue: `读取失败：${error instanceof Error ? error.message : "未知错误"}` }; }
      })));
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
    const supply = await this.preview(userId, input, input.sourceAccountId);
    const supplier = supply.suppliers[0];
    if (!supplier || supplier.issue || supplier.canProvide === null) throw new HttpError(409, "SOURCE_UNAVAILABLE", supplier?.issue ?? "供给账号不可用。");
    const sourceClient = this.deps.registry.require(sourceAccount.id).client;
    const targetClient = this.deps.registry.require(targetAccount.id).client;
    const [sourceProfile, sourceRawConfig, targetRawConfig, book] = await Promise.all([sourceClient.me(), sourceClient.marketConfig(), targetClient.marketConfig(), targetClient.marketFishOrderBook(input.fishId)]);
    const player = marketRead(masteryProfileSchema, sourceProfile).player;
    if (player.id !== supplier.playerId || !player.canAccessMarket) throw new HttpError(409, "ACCOUNT_CHANGED", "供给账号角色或市场权限已变化。");
    if (player.gold === undefined) throw new HttpError(502, "GAME_DATA_INVALID", "供给账号金币数据缺失。");
    const source: FishActor = { accountId: sourceAccount.id, label: sourceAccount.label, playerId: player.id, nickname: player.nickname, gold: player.gold, canAccessMarket: player.canAccessMarket };
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
