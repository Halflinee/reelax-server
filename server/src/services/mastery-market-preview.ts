import { z } from "zod";
import { HttpError } from "../api/server.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const configSchema = z.object({
  maxFishOrderQuantity: positive,
  fishMinimumPrices: z.array(z.object({ biomeId: z.string(), rarity: z.string(), configuredMinimumUnitPrice: nonnegative.nullable() })),
});
const bookSchema = z.object({
  version: nonnegative,
  sellLevels: z.array(z.object({ unitPrice: positive, quantity: positive })).max(50),
});

export type MasteryMarketInput = { fishId: string; quantity?: number; maxUnitPrice?: number; budget?: number };
export type MasteryMarketPreview = ReturnType<typeof planMasteryMarket> & {
  createdAt: number; target: { accountId: string; label: string; nickname: string };
};

/** 只计算限价委托和当前卖盘；匿名撮合不能据此推断某个出鱼账号会收到金币。 */
export function planMasteryMarket(data: {
  input: MasteryMarketInput;
  fish: { id: string; name: string; biomeId: string; rarity: string; sellPrice: number };
  missing: number; gold: number; config: unknown; book: unknown;
}) {
  const config = configSchema.safeParse(data.config);
  const book = bookSchema.safeParse(data.book);
  if (!config.success || !book.success) throw new HttpError(502, "GAME_DATA_INVALID", "市场配置或卖盘数据格式已变化，无法生成可靠购买预览。");
  const floor = config.data.fishMinimumPrices.find((entry) => entry.biomeId === data.fish.biomeId && entry.rarity === data.fish.rarity);
  const minimumUnitPrice = Math.max(data.fish.sellPrice, floor?.configuredMinimumUnitPrice ?? data.fish.sellPrice);
  if (minimumUnitPrice < 1) throw new HttpError(502, "GAME_DATA_INVALID", "市场最低价格无效。");
  const requestedQuantity = data.input.quantity ?? Math.min(data.missing, config.data.maxFishOrderQuantity);
  const maxUnitPrice = data.input.maxUnitPrice ?? minimumUnitPrice;
  const budget = data.input.budget ?? data.gold;
  const availableBudget = Math.min(budget, data.gold);
  const issues: string[] = [];
  if (maxUnitPrice < minimumUnitPrice) issues.push(`最高单价低于市场最低价格 ${minimumUnitPrice} 金币，不能提交该价格的委托。`);
  if (requestedQuantity > data.missing) issues.push("购买数量已按当前专精缺口缩减。");
  if (requestedQuantity > config.data.maxFishOrderQuantity) issues.push("购买数量已按市场单笔数量上限缩减。");
  if (budget > data.gold) issues.push("预算高于账号当前金币，按当前金币计算。");
  // 按最高单价计算冻结额，而非用便宜卖盘的预计成交价扩大委托量。
  const affordable = Number(BigInt(availableBudget) / BigInt(maxUnitPrice));
  const orderQuantity = maxUnitPrice < minimumUnitPrice ? 0 : Math.min(requestedQuantity, data.missing, config.data.maxFishOrderQuantity, affordable);
  if (affordable < Math.min(requestedQuantity, data.missing, config.data.maxFishOrderQuantity)) issues.push("按最高单价冻结金币后，预算不足以委托全部数量。");
  let expectedQuantity = 0;
  let expectedCostGold = 0;
  const fills: { unitPrice: number; quantity: number; costGold: number }[] = [];
  const levels = [...book.data.sellLevels].sort((a, b) => a.unitPrice - b.unitPrice);
  for (const level of levels) {
    if (level.unitPrice > maxUnitPrice || expectedQuantity >= orderQuantity) break;
    const quantity = Math.min(level.quantity, orderQuantity - expectedQuantity);
    const costGold = Number(BigInt(quantity) * BigInt(level.unitPrice));
    fills.push({ unitPrice: level.unitPrice, quantity, costGold });
    expectedQuantity += quantity;
    expectedCostGold += costGold;
  }
  const pendingQuantity = orderQuantity - expectedQuantity;
  if (pendingQuantity) issues.push("当前读取的卖盘不足以立即成交全部数量；实际委托时剩余部分可能挂单等待并冻结金币。");
  return {
    fishId: data.fish.id, name: data.fish.name, targetMissing: data.missing,
    gold: data.gold, minimumUnitPrice, maxOrderQuantity: config.data.maxFishOrderQuantity,
    requestedQuantity, maxUnitPrice, budget, orderQuantity,
    reserveGold: Number(BigInt(orderQuantity) * BigInt(maxUnitPrice)),
    expectedQuantity, expectedCostGold, pendingQuantity,
    bestAsk: levels[0]?.unitPrice ?? null, bookVersion: book.data.version, levelsRead: levels.length, fills, issues,
  };
}
