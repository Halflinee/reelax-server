// 双账号专精鱼供需预览。只读快照，不挂单、不解锁、不交换、不献祭。
import { z } from "zod";
import { HttpError } from "../api/server.ts";
import type { AccountService } from "./account-service.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import { readSwapTargets } from "./swap-plan.ts";
import { RARITIES, rarityLabel, rarityRank } from "../modules/shared/rarity.ts";

const quantity = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const profileSchema = z.object({ player: z.object({ id: z.string().min(1), nickname: z.string(), canAccessMarket: z.boolean() }) });
const inventorySchema = z.object({ fish: z.array(z.object({
  fishId: z.string().min(1), quantity, isLocked: z.boolean(),
  isManuallyLocked: z.boolean().optional(), isMasteryLocked: z.boolean().optional(),
  titanValueSummary: z.unknown().optional(),
})) });
const masterySchema = z.object({ biomes: z.array(z.object({
  biomeId: z.string().min(1), isUnlocked: z.boolean(),
  rarities: z.array(z.object({
    rarity: z.enum(RARITIES), fish: z.object({ id: z.string().min(1) }).nullable(),
    remainingQuantity: quantity, availableQuantity: quantity, isWaiting: z.boolean().optional(),
  })),
})) });
const catalogSchema = z.object({
  fish: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), rarity: z.enum(RARITIES), biomeId: z.string().min(1), sellPrice: quantity })),
  biomes: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
});

type AccountSummary = { accountId: string; label: string; nickname: string };
export type MasteryTransferRow = {
  fishId: string; name: string; rarityLabel: string; biomeName: string;
  targetMissing: number; sourceOwned: number; sourceReserved: number; sourceProtected: number;
  sourceCanProvide: number; suggestedQuantity: number;
  returnFish: { fishId: string; name: string; quantity: number; sourceNeedFilled: number }[];
  notes: string[];
};
export type MasteryTransferPreview = {
  createdAt: number; source: AccountSummary; target: AccountSummary;
  rows: MasteryTransferRow[]; issues: string[];
};

function read<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(502, "GAME_DATA_INVALID", `${label}数据不完整或格式已变化，无法生成可靠供需预览。`);
  return result.data;
}
type Catalog = z.infer<typeof catalogSchema>;
type Stock = { owned: number; protected: number; reserved: number; spare: number };

function snapshot(masteryRaw: unknown, inventoryRaw: unknown) {
  const mastery = read(masterySchema, masteryRaw, "专精目标");
  const inventory = read(inventorySchema, inventoryRaw, "鱼获背包");
  const required = new Map<string, number>();
  // 复用现有交换助手的「已解锁、非等待、尚未贡献完」目标定义。
  for (const target of readSwapTargets(mastery)) required.set(target.fishId, (required.get(target.fishId) ?? 0) + target.remaining);
  const stocks = new Map<string, Stock>();
  for (const item of inventory.fish) {
    const stock = stocks.get(item.fishId) ?? { owned: 0, protected: 0, reserved: 0, spare: 0 };
    stock.owned += item.quantity;
    if (item.isLocked || item.isManuallyLocked || item.isMasteryLocked || item.titanValueSummary != null) stock.protected += item.quantity;
    stocks.set(item.fishId, stock);
  }
  for (const [id, stock] of stocks) {
    stock.reserved = Math.min(stock.owned, required.get(id) ?? 0);
    // 自身所需与锁定保护可能重叠；同时满足两项约束，不把重叠部分重复扣除。
    stock.spare = Math.min(stock.owned - stock.reserved, stock.owned - stock.protected);
  }
  const missing = new Map([...required].map(([id, need]) => [id, Math.max(0, need - (stocks.get(id)?.owned ?? 0))]));
  return { stocks, missing };
}

/** 按当前供需分配回交换鱼，每条库存仅分配一次，不把同一批鱼重复计入多行方案。 */
export function planMasteryTransfer(input: {
  sourceMastery: unknown; sourceInventory: unknown; targetMastery: unknown; targetInventory: unknown;
  catalog: unknown; marketAvailable: boolean;
}): MasteryTransferRow[] {
  const catalog: Catalog = read(catalogSchema, input.catalog, "鱼类资料");
  const definitions = new Map(catalog.fish.map((fish) => [fish.id, fish]));
  const biomes = new Map(catalog.biomes.map((biome) => [biome.id, biome.name]));
  const source = snapshot(input.sourceMastery, input.sourceInventory);
  const target = snapshot(input.targetMastery, input.targetInventory);
  const definition = (id: string) => {
    const fish = definitions.get(id);
    if (!fish || !biomes.has(fish.biomeId)) throw new HttpError(502, "FISH_DATA_UNKNOWN", "鱼类资料与账号数据不一致，请重新读取预览。");
    return fish;
  };
  // 资料缺失不能当成「没有这条鱼」或凭名称猜测鱼种。
  for (const data of [source, target]) {
    for (const id of new Set([...data.stocks.keys(), ...data.missing.keys()])) definition(id);
  }
  const supply = new Map([...source.stocks].map(([id, stock]) => [id, stock.spare]));
  const returnPool = new Map([...target.stocks].map(([id, stock]) => [id, stock.spare]));
  const sourceMissing = new Map(source.missing);
  const needs = [...target.missing].filter(([, need]) => need > 0)
    .sort(([a], [b]) => rarityRank(definition(a).rarity) - rarityRank(definition(b).rarity) || a.localeCompare(b));
  return needs.map(([id, need]) => {
    const fish = definition(id);
    const stock = source.stocks.get(id);
    const sourceCanProvide = Math.min(need, supply.get(id) ?? 0);
    const supported = ["mythic", "exotic", "arcane"].includes(fish.rarity);
    const notes: string[] = [];
    const returnFish: MasteryTransferRow["returnFish"] = [];
    let suggestedQuantity = 0;
    if (input.marketAvailable && supported && sourceCanProvide > 0) {
      const choices = [...returnPool].filter(([otherId, count]) => count > 0 && otherId !== id && definition(otherId).rarity === fish.rarity)
        .sort(([a], [b]) => Number((sourceMissing.get(b) ?? 0) > 0) - Number((sourceMissing.get(a) ?? 0) > 0)
          || definition(a).sellPrice - definition(b).sellPrice || a.localeCompare(b));
      for (const [returnId, available] of choices) {
        const count = Math.min(sourceCanProvide - suggestedQuantity, available);
        if (!count) break;
        const sourceNeedFilled = Math.min(sourceMissing.get(returnId) ?? 0, count);
        returnFish.push({ fishId: returnId, name: definition(returnId).name, quantity: count, sourceNeedFilled });
        suggestedQuantity += count;
        returnPool.set(returnId, available - count);
        sourceMissing.set(returnId, (sourceMissing.get(returnId) ?? 0) - sourceNeedFilled);
      }
      supply.set(id, (supply.get(id) ?? 0) - suggestedQuantity);
    }
    if (!stock?.owned) notes.push("出鱼账号没有这条鱼。");
    else if (!sourceCanProvide) notes.push("扣除自身专精所需和锁定、倍率保护后，没有可提供的余量。");
    if (!supported) notes.push("此稀有度不支持以物易物，暂不提供定向交换方案。");
    else if (input.marketAvailable && sourceCanProvide > suggestedQuantity) notes.push("收鱼账号可用于回交换的同稀有度富余鱼不足。");
    return {
      fishId: id, name: fish.name, rarityLabel: rarityLabel(fish.rarity), biomeName: biomes.get(fish.biomeId)!,
      targetMissing: need, sourceOwned: stock?.owned ?? 0, sourceReserved: stock?.reserved ?? 0,
      sourceProtected: stock?.protected ?? 0, sourceCanProvide, suggestedQuantity, returnFish, notes,
    };
  }).sort((a, b) => Number(b.suggestedQuantity > 0) - Number(a.suggestedQuantity > 0)
    || Number(b.sourceCanProvide > 0) - Number(a.sourceCanProvide > 0) || a.fishId.localeCompare(b.fishId));
}

export class MasteryTransferPreviewService {
  private accounts: AccountService;
  private registry: RunnerRegistry;
  constructor(deps: { accounts: AccountService; registry: RunnerRegistry }) {
    this.accounts = deps.accounts;
    this.registry = deps.registry;
  }
  async preview(userId: string, sourceId: string, targetId: string): Promise<MasteryTransferPreview> {
    const source = this.accounts.getForUser(sourceId, userId);
    const target = this.accounts.getForUser(targetId, userId);
    if (source.id === target.id) throw new HttpError(400, "SAME_ACCOUNT", "出鱼和收鱼不能选择同一个账号。");
    if (source.baseUrl !== target.baseUrl) throw new HttpError(400, "DIFFERENT_GAME_SERVER", "两个账号必须属于同一个游戏服务器。");
    const sourceClient = this.registry.require(source.id).client;
    const targetClient = this.registry.require(target.id).client;
    const profiles = await Promise.all([sourceClient.me(), targetClient.me()]);
    const sourcePlayer = read(profileSchema, profiles[0], "出鱼账号").player;
    const targetPlayer = read(profileSchema, profiles[1], "收鱼账号").player;
    if (sourcePlayer.id === targetPlayer.id) throw new HttpError(400, "SAME_GAME_ACCOUNT", "这两条账号记录实际登录的是同一个游戏角色。");
    const [sourceMastery, sourceInventory, targetMastery, targetInventory, catalog] = await Promise.all([
      sourceClient.mastery(), sourceClient.inventoryFish(), targetClient.mastery(), targetClient.inventoryFish(), sourceClient.contentBootstrap(),
    ]);
    const issues: string[] = [];
    if (!sourcePlayer.canAccessMarket) issues.push("出鱼账号尚不能使用市场，只展示供需，不生成交换建议。");
    if (!targetPlayer.canAccessMarket) issues.push("收鱼账号尚不能使用市场，只展示供需，不生成交换建议。");
    return {
      createdAt: Date.now(),
      source: { accountId: source.id, label: source.label, nickname: sourcePlayer.nickname },
      target: { accountId: target.id, label: target.label, nickname: targetPlayer.nickname },
      rows: planMasteryTransfer({ sourceMastery, sourceInventory, targetMastery, targetInventory, catalog,
        marketAvailable: sourcePlayer.canAccessMarket && targetPlayer.canAccessMarket }),
      issues,
    };
  }
}
