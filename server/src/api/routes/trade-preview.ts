import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { query } from "../middleware/validate.ts";
import { TradePreviewService } from "../../services/trade-preview-service.ts";
import type { AccountService } from "../../services/account-service.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import { GameClientError } from "../../game/errors.ts";
import { HttpError } from "../server.ts";

const previewSchema = z.object({
  payerAccountId: z.string().min(1).max(64),
  receiverAccountId: z.string().min(1).max(64),
  amount: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export function createTradePreviewRouter(deps: { accounts: AccountService; registry: RunnerRegistry }): Router {
  const router = Router();
  const service = new TradePreviewService(deps);
  router.use(requireApproved);
  // 只提供读取预览的入口；没有挂单、购买、确认执行等路由。
  router.get("/", query(previewSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await service.preview(currentUserId(req), res.locals.query as z.infer<typeof previewSchema>));
    } catch (error) {
      if (error instanceof GameClientError) throw new HttpError(502, "GAME_READ_FAILED", `读取游戏数据失败：${error.message}`);
      throw error;
    }
  });
  return router;
}
