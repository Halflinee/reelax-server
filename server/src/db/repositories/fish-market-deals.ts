import { randomUUID } from "node:crypto";
import { BaseRepo, newId, now } from "./base.ts";
import { HttpError } from "../../api/server.ts";
import type { FishActor, FishDefinition } from "../../services/mastery-supply-service.ts";

export type FishMarketPlan = { createdAt: number; account: FishActor; baseUrl: string; fish: FishDefinition; quantity: number;
  buyPrice: number; sellPrice: number; maxCostGold: number; feeBasisPoints: number; expectedFeeGold: number; expectedProfitGold: number };
export type FishMarketDealStatus = "previewed" | "buying" | "buy_open" | "bought" | "selling" | "sell_open" | "completed" | "failed" | "review_required" | "closed";
export type FishMarketDealPayload = { plan: FishMarketPlan; message: string; buyOrderId: string | null; sellOrderId: string | null;
  stockBefore: { owned: number; spare: number } | null; boughtQuantity: number; costGold: number; soldQuantity: number;
  grossGold: number; feeGold: number; profitGold: number | null; pendingSide: "buy" | "sell" | null; buyKey: string; sellKey: string };
export type FishMarketDeal = FishMarketDealPayload & { id: string; status: FishMarketDealStatus; expiresAt: number; createdAt: number; updatedAt: number };
type Row = { id: string; user_id: string; status: FishMarketDealStatus; payload_json: string; expires_at: number; created_at: number; updated_at: number };
const view = (row: Row): FishMarketDeal => ({ ...JSON.parse(row.payload_json) as FishMarketDealPayload,
  id: row.id, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });
export const ACTIVE_MARKET_DEALS_SQL = "'buying','buy_open','bought','selling','sell_open','review_required'";

export class FishMarketDealsRepo extends BaseRepo {
  create(userId: string, plan: FishMarketPlan): FishMarketDeal {
    const id = newId(); const at = now();
    const payload: FishMarketDealPayload = { plan, message: "等待确认买入，尚未挂单。", buyOrderId: null, sellOrderId: null,
      stockBefore: null, boughtQuantity: 0, costGold: 0, soldQuantity: 0, grossGold: 0, feeGold: 0, profitGold: null, pendingSide: null, buyKey: randomUUID(), sellKey: randomUUID() };
    this.db.run(`INSERT INTO fish_market_deals(id,user_id,base_url,player_id,status,payload_json,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, id, userId, plan.baseUrl, plan.account.playerId, "previewed", JSON.stringify(payload), at + 5 * 60_000, at, at);
    return this.find(userId, id)!;
  }
  find(userId: string, id: string): FishMarketDeal | null {
    const row = this.db.get<Row>("SELECT * FROM fish_market_deals WHERE id=? AND user_id=?", id, userId);
    return row ? view(row) : null;
  }
  recent(userId: string): FishMarketDeal[] {
    return [
      ...this.db.all<Row>(`SELECT * FROM fish_market_deals WHERE user_id=? AND status IN (${ACTIVE_MARKET_DEALS_SQL}) ORDER BY created_at DESC`, userId),
      ...this.db.all<Row>(`SELECT * FROM fish_market_deals WHERE user_id=? AND status NOT IN (${ACTIVE_MARKET_DEALS_SQL}) ORDER BY created_at DESC LIMIT 10`, userId),
    ].map(view);
  }
  update(userId: string, id: string, status: FishMarketDealStatus, patch: Partial<FishMarketDealPayload>): FishMarketDeal {
    const current = this.find(userId, id);
    if (!current) throw new HttpError(404, "MARKET_DEAL_NOT_FOUND", "市场买卖记录不存在。");
    const { plan, message, buyOrderId, sellOrderId, stockBefore, boughtQuantity, costGold, soldQuantity, grossGold, feeGold, profitGold, pendingSide, buyKey, sellKey } = { ...current, ...patch };
    this.db.run("UPDATE fish_market_deals SET status=?,payload_json=?,updated_at=? WHERE id=? AND user_id=?", status,
      JSON.stringify({ plan, message, buyOrderId, sellOrderId, stockBefore, boughtQuantity, costGold, soldQuantity, grossGold, feeGold, profitGold, pendingSide, buyKey, sellKey }), now(), id, userId);
    return this.find(userId, id)!;
  }
  claim(userId: string, id: string, side: "buy" | "sell"): { operation: FishMarketDeal; started: boolean } {
    return this.db.tx(() => {
      const operation = this.find(userId, id);
      if (!operation) throw new HttpError(404, "MARKET_DEAL_NOT_FOUND", "市场买卖记录不存在。");
      const allowed = side === "buy" ? "previewed" : "bought";
      if (operation.status !== allowed) return { operation, started: false };
      if (side === "buy" && operation.expiresAt <= now()) throw new HttpError(409, "PREVIEW_EXPIRED", "买入预览已过期，请重新预览。");
      const { baseUrl, account } = operation.plan;
      const busy = this.db.get(`SELECT id FROM fish_market_deals WHERE id<>? AND base_url=? AND player_id=? AND status IN (${ACTIVE_MARKET_DEALS_SQL}) LIMIT 1`, id, baseUrl, account.playerId);
      const fishBusy = this.db.get(`SELECT id FROM fish_market_transfers WHERE base_url=? AND (buyer_player_id=? OR seller_player_id=?) AND status IN ('executing','review_required') LIMIT 1`, baseUrl, account.playerId, account.playerId);
      const goldBusy = this.db.get(`SELECT id FROM gold_transfers WHERE json_extract(payload_json,'$.preview.baseUrl')=? AND (payer_player_id=? OR receiver_player_id=?) AND status IN ('executing','review_required') LIMIT 1`, baseUrl, account.playerId, account.playerId);
      if (busy || fishBusy || goldBusy) throw new HttpError(409, "TRANSFER_BUSY", "该游戏角色已有进行中或待核对的交易，请先处理原记录。");
      return { operation: this.update(userId, id, side === "buy" ? "buying" : "selling", { message: side === "buy" ? "正在重新核对买入条件。" : "正在核对实际买入和可出售库存。" }), started: true };
    });
  }
  recoverInterrupted(): void {
    for (const row of this.db.all<Row>("SELECT * FROM fish_market_deals WHERE status IN ('buying','selling')")) {
      this.update(row.user_id, row.id, "review_required", { message: "服务重启中断了请求，请核对订单；不会自动重试买入或挂卖。" });
    }
  }
}
