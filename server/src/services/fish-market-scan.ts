// 鱼类市场只读扫描：现价往返与等待成交的挂单价差分开计算，不创建任何交易。
import { HttpError } from "../api/server.ts";
import type { AccountService } from "./account-service.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { Repos } from "../db/repositories/index.ts";
import { masteryProfileSchema } from "./mastery-transfer-preview.ts";
import { MasterySupplyService, fishBookSchema, fishMarketConfigSchema, marketRead, type FishDefinition } from "./mastery-supply-service.ts";
import { rarityLabel } from "../modules/shared/rarity.ts";
import type { z } from "zod";

type Book = z.infer<typeof fishBookSchema>;
type Config = z.infer<typeof fishMarketConfigSchema>;
type Fill = { unitPrice: number; quantity: number; gold: number };
export type MarketProfit = { quantity: number; buyPrice: number | null; sellPrice: number | null; costGold: number;
  grossGold: number; feeGold: number; netGold: number; profitGold: number; returnPercent: number; breakEvenPrice: number | null };
export type FishMarketRow = { fish: FishDefinition; readAt: number; bookVersion: number | null; feeBasisPoints: number | null;
  buyLevels: Book["buyLevels"]; sellLevels: Book["sellLevels"]; minimumPrice: number | null;
  immediate: (MarketProfit & { buyFills: Fill[]; sellFills: Fill[] }) | null; waiting: MarketProfit | null;
  waitingWithinLimits: boolean; notes: string[]; error: string | null };
export type FishMarketBatch = { readAt: number; accountId: string; gold: number; feeBasisPoints: number; rows: FishMarketRow[] };

const safe = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(400, "AMOUNT_TOO_LARGE", "金额超过可精确计算范围，请减少数量。");
  return Number(value);
};
const ceilDiv = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;
function profit(quantity: number, cost: bigint, gross: bigint, fee: bigint, rate: number, buyPrice: number | null, sellPrice: number | null): MarketProfit {
  const net = gross - fee; const gain = net - cost;
  // 按每条鱼的手续费向上取整估算，避免分笔成交让预计利润偏高。
  const perFishNet = ceilDiv(cost, BigInt(quantity));
  const breakEven = rate === 10000 ? null : ceilDiv(perFishNet * 10000n, BigInt(10000 - rate));
  return { quantity, buyPrice, sellPrice, costGold: safe(cost), grossGold: safe(gross), feeGold: safe(fee), netGold: safe(net), profitGold: safe(gain),
    returnPercent: Number(gain * 10000n / cost) / 100, breakEvenPrice: breakEven === null || breakEven > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(breakEven) };
}
function fills(levels: Book["buyLevels"], requested: number): Fill[] | null {
  let remaining = requested; const result: Fill[] = [];
  for (const level of levels) {
    const quantity = Math.min(remaining, level.quantity);
    result.push({ unitPrice: level.unitPrice, quantity, gold: safe(BigInt(quantity) * BigInt(level.unitPrice)) });
    remaining -= quantity; if (!remaining) return result;
  }
  return null;
}
export function analyzeFishMarket(fish: FishDefinition, quantity: number, gold: number, config: Config, book: Book): FishMarketRow {
  const buyLevels = [...book.buyLevels].sort((a, b) => b.unitPrice - a.unitPrice);
  const sellLevels = [...book.sellLevels].sort((a, b) => a.unitPrice - b.unitPrice);
  const floor = config.fishMinimumPrices.find((entry) => entry.biomeId === fish.biomeId && entry.rarity === fish.rarity)?.configuredMinimumUnitPrice;
  const minimumPrice = Math.max(1, fish.sellPrice, floor ?? fish.sellPrice);
  const row: FishMarketRow = { fish, readAt: Date.now(), bookVersion: book.version, feeBasisPoints: config.sellerFeeBasisPoints, buyLevels, sellLevels,
    minimumPrice, immediate: null, waiting: null, waitingWithinLimits: false, notes: [], error: null };
  if (quantity > config.maxFishOrderQuantity) row.notes.push(`数量超过市场单笔上限 ${config.maxFishOrderQuantity} 条。`);
  if (config.activeOrderCount >= config.maxActiveOrdersPerPlayer) row.notes.push("账号挂单额度已满。");
  const highestBid = buyLevels[0]?.unitPrice; const lowestAsk = sellLevels[0]?.unitPrice;
  if (highestBid === undefined || lowestAsk === undefined) {
    row.notes.push("缺少买盘或卖盘，无法从双边报价估算价差收益。"); return row;
  }
  if (highestBid >= lowestAsk) {
    row.notes.push("买卖报价交叉，可能正在撮合或数据更新，请重新扫描；不将该快照视为套利机会。"); return row;
  }
  const buyFills = fills(sellLevels, quantity); const sellFills = fills(buyLevels.filter((level) => level.unitPrice >= minimumPrice), quantity);
  if (highestBid < minimumPrice) row.notes.push("当前最高买价低于市场允许的卖出底价，不能按该价格立即卖出。");
  else if (buyFills && sellFills) {
    const cost = buyFills.reduce((sum, entry) => sum + BigInt(entry.gold), 0n);
    const gross = sellFills.reduce((sum, entry) => sum + BigInt(entry.gold), 0n);
    const fee = sellFills.reduce((sum, entry) => sum + ceilDiv(BigInt(entry.unitPrice) * BigInt(config.sellerFeeBasisPoints), 10000n) * BigInt(entry.quantity), 0n);
    row.immediate = { ...profit(quantity, cost, gross, fee, config.sellerFeeBasisPoints, null, null), buyFills, sellFills };
    if (cost > BigInt(gold)) row.notes.push("按现价买入所需金币超过当前余额。");
  } else row.notes.push("当前读取的前 50 档买盘或卖盘数量不足，无法估算所选数量的完整现价往返。");
  const buyPrice = Math.max(minimumPrice, highestBid + 1); const sellPrice = lowestAsk - 1;
  if (!Number.isSafeInteger(buyPrice) || buyPrice >= lowestAsk || sellPrice <= buyPrice) {
    row.notes.push("买卖报价之间没有可用于低买高卖的整数价格空档。"); return row;
  }
  const cost = BigInt(buyPrice) * BigInt(quantity); const gross = BigInt(sellPrice) * BigInt(quantity);
  const fee = ceilDiv(BigInt(sellPrice) * BigInt(config.sellerFeeBasisPoints), 10000n) * BigInt(quantity);
  row.waiting = profit(quantity, cost, gross, fee, config.sellerFeeBasisPoints, buyPrice, sellPrice);
  row.waitingWithinLimits = cost <= BigInt(gold) && quantity <= config.maxFishOrderQuantity && config.activeOrderCount < config.maxActiveOrdersPerPlayer;
  if (cost > BigInt(gold)) row.notes.push("挂单买入所需本金超过当前余额。");
  if (row.waiting.profitGold <= 0) row.notes.push("按保守税费估算，挂单价差扣税后没有正收益。");
  return row;
}

export class FishMarketScanService {
  private catalog: MasterySupplyService;
  private deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos };
  constructor(deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos }) { this.deps = deps; this.catalog = new MasterySupplyService(deps); }
  async options(userId: string, accountId: string) {
    const catalog = await this.catalog.marketCatalog(userId, accountId);
    return { biomes: catalog.biomes, fish: catalog.fish.map((fish) => ({ ...fish, rarityLabel: rarityLabel(fish.rarity) })) };
  }
  async scan(userId: string, input: { accountId: string; fishIds: string[]; quantity: number }): Promise<FishMarketBatch> {
    const account = this.deps.accounts.getForUser(input.accountId, userId);
    const client = this.deps.registry.require(account.id).client;
    const catalog = await this.catalog.marketCatalog(userId, account.id);
    const fish = input.fishIds.map((id) => {
      const found = catalog.fish.find((entry) => entry.id === id);
      const biome = catalog.biomes.find((entry) => entry.id === found?.biomeId);
      if (!found || !biome) throw new HttpError(400, "UNKNOWN_FISH", "所选鱼种或地图不在本地资料中，请更新固定资料后重试。");
      return { ...found, biomeName: biome.name, rarityLabel: rarityLabel(found.rarity) };
    });
    const [profileRaw, configRaw] = await Promise.all([client.me(), client.marketConfig()]);
    const player = marketRead(masteryProfileSchema, profileRaw).player;
    if (!player.canAccessMarket) throw new HttpError(400, "MARKET_UNAVAILABLE", "所选账号尚不能使用市场。");
    if (player.gold === undefined) throw new HttpError(502, "GAME_DATA_INVALID", "账号金币数据缺失，无法计算本金。");
    const gold = player.gold; const config = marketRead(fishMarketConfigSchema, configRaw);
    const rows = await Promise.all(fish.map(async (definition): Promise<FishMarketRow> => {
      try {
        const book = marketRead(fishBookSchema, await client.marketFishOrderBook(definition.id));
        return analyzeFishMarket(definition, input.quantity, gold, config, book);
      } catch (error) {
        return { fish: definition, readAt: Date.now(), bookVersion: null, feeBasisPoints: config.sellerFeeBasisPoints, minimumPrice: null,
          buyLevels: [], sellLevels: [], immediate: null, waiting: null, waitingWithinLimits: false, notes: [], error: error instanceof Error ? error.message : "读取盘口失败" };
      }
    }));
    return { accountId: account.id, readAt: Date.now(), gold, feeBasisPoints: config.sellerFeeBasisPoints, rows };
  }
}
