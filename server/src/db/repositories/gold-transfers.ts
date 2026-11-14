import { BaseRepo, newId, now } from "./base.ts";
import type { TradePreview } from "../../services/trade-preview-service.ts";
import { HttpError } from "../../api/server.ts";
import { randomUUID } from "node:crypto";

export type GoldTransferStatus = "previewed" | "executing" | "completed" | "failed" | "review_required" | "closed";
export type GoldSettlement = { tradeId: string; grossGold: number; feeGold: number; netGold: number };
export type GoldTransferPayload = {
  preview: TradePreview;
  message: string;
  orderId: string | null;
  baseline: { payer: string[]; receiver: string[] } | null;
  settlement: GoldSettlement | null;
  listingKey: string;
  purchaseKey: string;
};
export type GoldTransfer = GoldTransferPayload & { id: string; status: GoldTransferStatus; expiresAt: number; createdAt: number; updatedAt: number };
type Row = { id: string; status: GoldTransferStatus; payload_json: string; expires_at: number; created_at: number; updated_at: number };
const view = (row: Row): GoldTransfer => ({ ...JSON.parse(row.payload_json) as GoldTransferPayload,
  id: row.id, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });

export class GoldTransfersRepo extends BaseRepo {
  create(userId: string, preview: TradePreview): GoldTransfer {
    const id = newId();
    const at = now();
    const payload: GoldTransferPayload = { preview, message: "等待手动确认，尚未交易。", orderId: null, baseline: null, settlement: null,
      listingKey: randomUUID(), purchaseKey: randomUUID() };
    this.db.run(`INSERT INTO gold_transfers(id,user_id,payer_player_id,receiver_player_id,status,payload_json,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, id, userId, preview.payer.playerId, preview.receiver.playerId, "previewed", JSON.stringify(payload), at + 5 * 60_000, at, at);
    return this.find(userId, id)!;
  }
  find(userId: string, id: string): GoldTransfer | null {
    const row = this.db.get<Row>("SELECT * FROM gold_transfers WHERE id=? AND user_id=?", id, userId);
    return row ? view(row) : null;
  }
  recent(userId: string): GoldTransfer[] {
    const open = this.db.all<Row>("SELECT * FROM gold_transfers WHERE user_id=? AND status IN ('executing','review_required') ORDER BY created_at DESC", userId);
    const recent = this.db.all<Row>("SELECT * FROM gold_transfers WHERE user_id=? AND status IN ('completed','failed','closed') ORDER BY created_at DESC LIMIT 10", userId);
    return [...open, ...recent].map(view);
  }
  update(userId: string, id: string, status: GoldTransferStatus, patch: Partial<GoldTransferPayload>): GoldTransfer {
    const current = this.find(userId, id);
    if (!current) throw new HttpError(404, "TRANSFER_NOT_FOUND", "交易记录不存在。");
    const { preview, message, orderId, baseline, settlement, listingKey, purchaseKey } = { ...current, ...patch };
    this.db.run("UPDATE gold_transfers SET status=?,payload_json=?,updated_at=? WHERE id=? AND user_id=?",
      status, JSON.stringify({ preview, message, orderId, baseline, settlement, listingKey, purchaseKey }), now(), id, userId);
    return this.find(userId, id)!;
  }
  claim(userId: string, id: string): { operation: GoldTransfer; started: boolean } {
    return this.db.tx(() => {
      const operation = this.find(userId, id);
      if (!operation) throw new HttpError(404, "TRANSFER_NOT_FOUND", "交易记录不存在。");
      if (operation.status !== "previewed") return { operation, started: false };
      if (operation.expiresAt < now()) throw new HttpError(409, "PREVIEW_EXPIRED", "预览已过期，请重新生成预览。");
      const { payer, receiver } = operation.preview;
      const busy = this.db.get<{ id: string }>(`SELECT id FROM gold_transfers WHERE status IN ('executing','review_required')
        AND json_extract(payload_json,'$.preview.baseUrl')=?
        AND (payer_player_id IN (?,?) OR receiver_player_id IN (?,?)) LIMIT 1`, operation.preview.baseUrl, payer.playerId, receiver.playerId, payer.playerId, receiver.playerId);
      if (busy) throw new HttpError(409, "TRANSFER_BUSY", "相关账号已有进行中或待核对的交易，请先处理该记录。");
      return { operation: this.update(userId, id, "executing", { message: "正在重新核对账号、金额和装备。" }), started: true };
    });
  }
  recoverInterrupted(): void {
    for (const row of this.db.all<Row & { user_id: string }>("SELECT * FROM gold_transfers WHERE status='executing'")) {
      this.update(row.user_id, row.id, "review_required", { message: "服务重启中断了交易，结果需要核对；不会自动重试交易。" });
    }
  }
}
