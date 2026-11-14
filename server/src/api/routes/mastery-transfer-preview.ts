import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { query } from "../middleware/validate.ts";
import { MasteryTransferPreviewService } from "../../services/mastery-transfer-preview.ts";
import type { AccountService } from "../../services/account-service.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import { GameClientError } from "../../game/errors.ts";
import { HttpError } from "../server.ts";

const inputSchema = z.object({ sourceAccountId: z.string().min(1).max(64), targetAccountId: z.string().min(1).max(64) }).strict();

export function createMasteryTransferPreviewRouter(deps: { accounts: AccountService; registry: RunnerRegistry }): Router {
  const router = Router();
  const service = new MasteryTransferPreviewService(deps);
  router.use(requireApproved);
  router.get("/", query(inputSchema), async (req, res) => {
    const input = res.locals.query as z.infer<typeof inputSchema>;
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await service.preview(currentUserId(req), input.sourceAccountId, input.targetAccountId));
    } catch (error) {
      if (error instanceof GameClientError) throw new HttpError(502, "GAME_READ_FAILED", `读取游戏数据失败：${error.message}`);
      throw error;
    }
  });
  return router;
}
