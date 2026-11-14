// 金币交易预览：只读取账号、市场和装备数据，不创建或购买订单。
import { z } from "zod";
import { HttpError } from "../api/server.ts";
import type { RunnerRegistry } from "../game/runner-registry.ts";
import type { AccountService } from "./account-service.ts";
import { RARITIES, rarityLabel, rarityRank } from "../modules/shared/rarity.ts";

const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const playerSchema = z.object({
  player: z.object({ id: z.string().min(1), nickname: z.string(), gold: money, canAccessMarket: z.boolean() }),
});
const configSchema = z.object({
  sellerFeeBasisPoints: z.number().int().min(0).max(10000),
  activeOrderCount: z.number().int().min(0),
  maxActiveOrdersPerPlayer: z.number().int().min(0),
  gearMinimumPrices: z.array(z.object({
    rarity: z.string(),
    effectiveBaseMinimumUnitPrice: money,
  })),
});
const gearSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), rarity: z.enum(RARITIES), slot: z.string(),
  quality: z.number().finite(), upgradeLevel: z.number().int().min(0), sellValue: money,
  isLocked: z.boolean(), equippedSlot: z.string().nullable(), marketOrderId: z.string().nullable(),
});
const inventorySchema = z.object({ gear: z.array(gearSchema), nextCursor: z.string().min(1).nullish() });

export type TradePreviewInput = { payerAccountId: string; receiverAccountId: string; amount: number };
type PreviewAccount = { accountId: string; playerId: string; label: string; nickname: string; gold: number };
export type TradePreview = {
  createdAt: number;
  baseUrl: string;
  payer: PreviewAccount;
  receiver: PreviewAccount;
  requestedGold: number;
  grossGold: number;
  feeGold: number;
  netGold: number;
  feeBasisPoints: number;
  candidate: {
    id: string; name: string; rarityLabel: string; quality: number; upgradeLevel: number;
    minimumPrice: number; sellValue: number;
  } | null;
  candidateCount: number;
  scannedGearCount: number;
  issues: string[];
  confirmation?: { id: string; expiresAt: number };
};

function readGameData<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(502, "GAME_DATA_INVALID", `${label}数据不完整或格式已变化，无法生成可靠预览。`);
  return result.data;
}

/** 与官方的「成交额 - 向下取整的税费」一致，用整数运算避免大金额精度损失。 */
export function calculateTradeGold(amount: number, feeBasisPoints: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, "INVALID_AMOUNT", "金币数量必须是有效的正整数。");
  if (!Number.isInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints >= 10000) {
    throw new HttpError(502, "INVALID_MARKET_FEE", "当前市场税率无法计算到账金额。");
  }
  const rate = BigInt(feeBasisPoints);
  const gross = ((BigInt(amount) - 1n) * 10000n) / (10000n - rate) + 1n;
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(400, "AMOUNT_TOO_LARGE", "含手续费的金额过大，请减少金币数量。");
  const fee = gross * rate / 10000n;
  return { grossGold: Number(gross), feeGold: Number(fee), netGold: Number(gross - fee) };
}

export class TradePreviewService {
  private accounts: AccountService;
  private registry: RunnerRegistry;

  constructor(deps: { accounts: AccountService; registry: RunnerRegistry }) {
    this.accounts = deps.accounts;
    this.registry = deps.registry;
  }

  async preview(userId: string, input: TradePreviewInput, candidateId?: string): Promise<TradePreview> {
    // 两个账号都必须先通过归属校验，再允许任何游戏请求。
    const payer = this.accounts.getForUser(input.payerAccountId, userId);
    const receiver = this.accounts.getForUser(input.receiverAccountId, userId);
    if (payer.id === receiver.id) throw new HttpError(400, "SAME_ACCOUNT", "付款和收款不能选择同一个账号。");
    if (payer.baseUrl !== receiver.baseUrl) throw new HttpError(400, "DIFFERENT_GAME_SERVER", "两个账号必须属于同一个游戏服务器。");
    const payerClient = this.registry.require(payer.id).client;
    const receiverClient = this.registry.require(receiver.id).client;
    const [payerRaw, receiverRaw] = await Promise.all([payerClient.me(), receiverClient.me()]);
    const payerPlayer = readGameData(playerSchema, payerRaw, "付款账号").player;
    const receiverPlayer = readGameData(playerSchema, receiverRaw, "收款账号").player;
    if (payerPlayer.id === receiverPlayer.id) throw new HttpError(400, "SAME_GAME_ACCOUNT", "这两条账号记录实际登录的是同一个游戏角色。");
    for (const [label, player] of [["付款账号", payerPlayer], ["收款账号", receiverPlayer]] as const) {
      if (!player.canAccessMarket) throw new HttpError(409, "MARKET_UNAVAILABLE", `${label}尚不能使用游戏市场，请先在游戏内检查市场权限。`);
    }
    const config = readGameData(configSchema, await receiverClient.marketConfig(), "市场配置");
    const amounts = calculateTradeGold(input.amount, config.sellerFeeBasisPoints);
    const gear: z.infer<typeof gearSchema>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const inventory = readGameData(inventorySchema, await receiverClient.gearInventory(cursor), "装备背包");
      gear.push(...inventory.gear);
      cursor = inventory.nextCursor ?? undefined;
      if (!cursor) break;
      if (cursors.has(cursor) || page === 19) throw new HttpError(502, "INVENTORY_INCOMPLETE", "未能完整读取装备背包，请稍后重试。");
      cursors.add(cursor);
    }
    const available = gear.filter((item) => !item.isLocked && !item.equippedSlot && !item.marketOrderId
      && item.slot !== "magic_stone" && item.rarity !== "exotic" && item.rarity !== "arcane");
    const candidates = available.map((item) => {
      const rule = config.gearMinimumPrices.find((r) => r.rarity === item.rarity);
      if (!rule) throw new HttpError(502, "GEAR_PRICE_UNKNOWN", `未读到${rarityLabel(item.rarity)}装备的最低售价，无法生成可靠预览。`);
      return { ...item, minimumPrice: rule.effectiveBaseMinimumUnitPrice };
    }).filter((item) => item.minimumPrice <= amounts.grossGold)
      .sort((a, b) => a.sellValue - b.sellValue || rarityRank(a.rarity) - rarityRank(b.rarity) || a.id.localeCompare(b.id));
    const candidate = candidateId ? candidates.find((item) => item.id === candidateId) : candidates[0];
    const issues: string[] = [];
    if (payerPlayer.gold < amounts.grossGold) issues.push(`付款账号金币不足，还差 ${(amounts.grossGold - payerPlayer.gold).toLocaleString("zh-CN")} 金币。`);
    if (config.activeOrderCount >= config.maxActiveOrdersPerPlayer) issues.push("收款账号的市场挂单数量已达上限。");
    if (!available.length) issues.push("收款账号没有无需验证码、未穿戴、未锁定且未上架的可用装备。");
    else if (!candidate) issues.push("输入金额低于现有装备的最低售价要求，请调高金额或更换收款账号。");
    if (candidateId && !candidate) issues.push("预览中确认的装备已变化或不可用，请重新生成预览。");
    return {
      createdAt: Date.now(),
      baseUrl: payer.baseUrl,
      payer: { accountId: payer.id, playerId: payerPlayer.id, label: payer.label, nickname: payerPlayer.nickname, gold: payerPlayer.gold },
      receiver: { accountId: receiver.id, playerId: receiverPlayer.id, label: receiver.label, nickname: receiverPlayer.nickname, gold: receiverPlayer.gold },
      requestedGold: input.amount, ...amounts, feeBasisPoints: config.sellerFeeBasisPoints,
      candidate: candidate ? {
        id: candidate.id, name: candidate.name, rarityLabel: rarityLabel(candidate.rarity), quality: candidate.quality,
        upgradeLevel: candidate.upgradeLevel, minimumPrice: candidate.minimumPrice, sellValue: candidate.sellValue,
      } : null,
      candidateCount: candidates.length, scannedGearCount: gear.length, issues,
    };
  }
}
