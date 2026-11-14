import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body, query } from "../middleware/validate.ts";
import { TradePreviewService } from "../../services/trade-preview-service.ts";
import type { AccountService } from "../../services/account-service.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import { GameClientError } from "../../game/errors.ts";
import { HttpError } from "../server.ts";
import type { Repos } from "../../db/repositories/index.ts";
import { GoldTransferService } from "../../services/gold-transfer-service.ts";

const previewSchema = z.object({
  payerAccountId: z.string().min(1).max(64),
  receiverAccountId: z.string().min(1).max(64),
  amount: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export function createTradePreviewRouter(deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos }): Router {
  const router = Router();
  const service = new TradePreviewService(deps);
  const transfers = new GoldTransferService(deps);
  router.use(requireApproved);
  router.get("/", query(previewSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const userId = currentUserId(req);
      const preview = await service.preview(userId, res.locals.query as z.infer<typeof previewSchema>);
      res.json({ ...preview, confirmation: transfers.prepare(userId, preview) });
    } catch (error) {
      if (error instanceof GameClientError) throw new HttpError(502, "GAME_READ_FAILED", `读取游戏数据失败：${error.message}`);
      throw error;
    }
  });
  router.get("/operations", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(transfers.recent(currentUserId(req)));
  });
  router.get("/operations/:id", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(transfers.get(currentUserId(req), req.params.id as string));
  });
  const confirmation = z.object({ confirmed: z.literal(true) }).strict();
  router.post("/operations/:id/confirm", body(confirmation), (req, res) => {
    res.json(transfers.confirm(currentUserId(req), req.params.id as string));
  });
  router.post("/operations/:id/check", async (req, res) => {
    res.json(await transfers.check(currentUserId(req), req.params.id as string));
  });
  router.post("/operations/:id/close", body(confirmation), (req, res) => {
    res.json(transfers.close(currentUserId(req), req.params.id as string));
  });
  return router;
}
