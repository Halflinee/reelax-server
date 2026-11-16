import { randomUUID } from "node:crypto";
import { BaseRepo, newId, now } from "./base.ts";
import { HttpError } from "../../api/server.ts";
import type { FishTradeQuote } from "../../services/mastery-supply-service.ts";

export type FishTransferStatus = "previewed" | "executing" | "completed" | "failed" | "review_required" | "closed";
export type FishSettlement = { quantity: number; grossGold: number; feeGold: number; netGold: number; tradeIds: string[] };
export type FishTransferPayload = {
  quote: FishTradeQuote; message: string; buyerOrderId: string | null; sellerOrderId: string | null;
  baseline: { buyer: string[]; seller: string[] } | null; settlement: FishSettlement | null;
  buyKey: string; sellKey: string;
};
export type FishTransfer = FishTransferPayload & { id: string; status: FishTransferStatus; expiresAt: number; createdAt: number; updatedAt: number };
type Row = { id: string; status: FishTransferStatus; payload_json: string; expires_at: number; created_at: number; updated_at: number };
const view = (row: Row): FishTransfer => ({ ...JSON.parse(row.payload_json) as FishTransferPayload,
  id: row.id, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });

export class FishTransfersRepo extends BaseRepo {
  create(userId: string, quote: FishTradeQuote): FishTransfer {
    const id = newId(); const at = now();
    const payload: FishTransferPayload = { quote, message: "等待手动确认，尚未挂单。", buyerOrderId: null, sellerOrderId: null,
      baseline: null, settlement: null, buyKey: randomUUID(), sellKey: randomUUID() };
    this.db.run(`INSERT INTO fish_market_transfers(id,user_id,base_url,buyer_player_id,seller_player_id,status,payload_json,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, id, userId, quote.baseUrl, quote.target.playerId, quote.source.playerId, "previewed", JSON.stringify(payload), at + 5 * 60_000, at, at);
    return this.find(userId, id)!;
  }
  find(userId: string, id: string): FishTransfer | null {
    const row = this.db.get<Row>("SELECT * FROM fish_market_transfers WHERE id=? AND user_id=?", id, userId);
    return row ? view(row) : null;
  }
  recent(userId: string): FishTransfer[] {
    return [
      ...this.db.all<Row>("SELECT * FROM fish_market_transfers WHERE user_id=? AND status IN ('executing','review_required') ORDER BY created_at DESC", userId),
      ...this.db.all<Row>("SELECT * FROM fish_market_transfers WHERE user_id=? AND status IN ('completed','failed','closed') ORDER BY created_at DESC LIMIT 10", userId),
    ].map(view);
  }
  update(userId: string, id: string, status: FishTransferStatus, patch: Partial<FishTransferPayload>): FishTransfer {
    const current = this.find(userId, id);
    if (!current) throw new HttpError(404, "FISH_TRANSFER_NOT_FOUND", "专精鱼交易记录不存在。");
    const { quote, message, buyerOrderId, sellerOrderId, baseline, settlement, buyKey, sellKey } = { ...current, ...patch };
    this.db.run("UPDATE fish_market_transfers SET status=?,payload_json=?,updated_at=? WHERE id=? AND user_id=?", status,
      JSON.stringify({ quote, message, buyerOrderId, sellerOrderId, baseline, settlement, buyKey, sellKey }), now(), id, userId);
    return this.find(userId, id)!;
  }
  claim(userId: string, id: string): { operation: FishTransfer; started: boolean } {
    return this.db.tx(() => {
      const operation = this.find(userId, id);
      if (!operation) throw new HttpError(404, "FISH_TRANSFER_NOT_FOUND", "专精鱼交易记录不存在。");
      if (operation.status !== "previewed") return { operation, started: false };
      if (operation.expiresAt <= now()) throw new HttpError(409, "PREVIEW_EXPIRED", "预览已过期，请重新预览。");
      const { target, source, baseUrl } = operation.quote;
      const fishBusy = this.db.get<{ id: string }>(`SELECT id FROM fish_market_transfers WHERE status IN ('executing','review_required') AND base_url=?
        AND (buyer_player_id IN (?,?) OR seller_player_id IN (?,?)) LIMIT 1`, baseUrl, target.playerId, source.playerId, target.playerId, source.playerId);
      const goldBusy = this.db.get<{ id: string }>(`SELECT id FROM gold_transfers WHERE status IN ('executing','review_required')
        AND json_extract(payload_json,'$.preview.baseUrl')=? AND (payer_player_id IN (?,?) OR receiver_player_id IN (?,?)) LIMIT 1`,
        baseUrl, target.playerId, source.playerId, target.playerId, source.playerId);
      if (fishBusy || goldBusy) throw new HttpError(409, "TRANSFER_BUSY", "相关账号已有进行中或待核对的金币或专精鱼交易，请先处理。");
      return { operation: this.update(userId, id, "executing", { message: "正在重新核对专精缺口、供给余量和市场盘口。" }), started: true };
    });
  }
  recoverInterrupted(): void {
    for (const row of this.db.all<Row & { user_id: string }>("SELECT * FROM fish_market_transfers WHERE status='executing'")) {
      this.update(row.user_id, row.id, "review_required", { message: "服务重启中断了交易，结果需要核对；不会自动重试挂单或卖出。" });
    }
  }
}
