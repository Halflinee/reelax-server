import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { currentUserId, requireApproved } from "../../auth/middleware.ts";
import { body, query } from "../middleware/validate.ts";
import { MasteryTransferPreviewService } from "../../services/mastery-transfer-preview.ts";
import type { AccountService } from "../../services/account-service.ts";
import type { RunnerRegistry } from "../../game/runner-registry.ts";
import { GameClientError } from "../../game/errors.ts";
import { HttpError } from "../server.ts";
import { MasterySupplyService } from "../../services/mastery-supply-service.ts";
import { FishTransferService } from "../../services/fish-transfer-service.ts";
import type { Repos } from "../../db/repositories/index.ts";
import { FishMarketScanService } from "../../services/fish-market-scan.ts";
import { FishMarketDealService } from "../../services/fish-market-deal-service.ts";

const inputSchema = z.object({ sourceAccountId: z.string().min(1).max(64), targetAccountId: z.string().min(1).max(64) }).strict();
const marketSchema = inputSchema.extend({
  fishId: z.string().min(1).max(128),
  quantity: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxUnitPrice: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  budget: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
const id = z.string().min(1).max(64);
const demandSchema = z.object({ targetAccountId: id }).strict();
const supplySchema = demandSchema.extend({ biomeId: id, fishId: z.string().min(1).max(128) }).strict();
const quoteSchema = supplySchema.extend({ sourceAccountId: id,
  quantity: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  unitPrice: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export function createMasteryTransferPreviewRouter(deps: { accounts: AccountService; registry: RunnerRegistry; repos: Repos }): Router {
  const router = Router();
  const service = new MasteryTransferPreviewService(deps);
  const supply = new MasterySupplyService(deps);
  const marketScan = new FishMarketScanService(deps);
  const marketDeals = new FishMarketDealService(deps);
  const transfers = new FishTransferService(deps);
  router.use(requireApproved);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const marketPrice = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  router.post("/market-deals/preview", body(z.object({ accountId: id, fishId: z.string().min(1).max(128), quantity: marketPrice, buyPrice: marketPrice, sellPrice: marketPrice }).strict()), async (req, res) => {
    res.json(await marketDeals.prepare(currentUserId(req), req.body));
  });
  router.get("/market-deals", (req, res) => { res.json(marketDeals.recent(currentUserId(req))); });
  router.get("/market-deals/:id", (req, res) => { res.json(marketDeals.get(currentUserId(req), req.params.id as string)); });
  for (const side of ["buy", "sell"] as const) router.post(`/market-deals/:id/${side}`, body(z.object({ confirmed: z.literal(true), acceptPublicMatching: z.literal(true) }).strict()), (req, res) => {
    res.json(marketDeals.confirm(currentUserId(req), req.params.id as string, side));
  });
  router.post("/market-deals/:id/check", body(z.object({}).strict()), async (req, res) => { res.json(await marketDeals.check(currentUserId(req), req.params.id as string)); });
  router.post("/market-deals/:id/close", body(z.object({ confirmed: z.literal(true), handledInGame: z.literal(true) }).strict()), (req, res) => { res.json(marketDeals.close(currentUserId(req), req.params.id as string)); });
  router.get("/market-scan/options", query(z.object({ accountId: id }).strict()), async (req, res) => {
    res.json(await marketScan.options(currentUserId(req), (res.locals.query as { accountId: string }).accountId));
  });
  router.post("/market-scan", body(z.object({ accountId: id, fishIds: z.array(z.string().min(1).max(128)).min(1).max(3).refine((ids) => new Set(ids).size === ids.length),
    quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()), async (req, res) => {
    res.json(await marketScan.scan(currentUserId(req), req.body));
  });
  router.post("/catalog/refresh", body(demandSchema), async (req, res) => {
    res.json(await supply.refreshCatalog(currentUserId(req), (req.body as z.infer<typeof demandSchema>).targetAccountId));
  });
  router.get("/demand", query(demandSchema), async (req, res) => {
    res.json(await supply.options(currentUserId(req), (res.locals.query as z.infer<typeof demandSchema>).targetAccountId));
  });
  router.get("/supply", query(supplySchema), async (req, res) => {
    res.json(await supply.preview(currentUserId(req), res.locals.query as z.infer<typeof supplySchema>));
  });
  router.get("/quote", query(quoteSchema), async (req, res) => {
    const userId = currentUserId(req);
    const quote = await supply.quote(userId, res.locals.query as z.infer<typeof quoteSchema>);
    res.json({ ...quote, confirmation: transfers.prepare(userId, quote) });
  });
  const autoQuoteSchema = quoteSchema.omit({ unitPrice: true }).strict();
  router.get("/auto-quote", query(autoQuoteSchema), async (req, res) => {
    const userId = currentUserId(req);
    const quote = await supply.quote(userId, res.locals.query as z.infer<typeof autoQuoteSchema>);
    res.json({ ...quote, confirmation: transfers.prepare(userId, quote) });
  });
  router.get("/operations", (req, res) => { res.json(transfers.recent(currentUserId(req))); });
  router.get("/operations/:id", (req, res) => { res.json(transfers.get(currentUserId(req), req.params.id as string)); });
  router.post("/operations/:id/confirm", body(z.object({ confirmed: z.literal(true), acceptPublicMatching: z.literal(true) }).strict()), (req, res) => {
    res.json(transfers.confirm(currentUserId(req), req.params.id as string));
  });
  router.post("/operations/:id/check", async (req, res) => { res.json(await transfers.check(currentUserId(req), req.params.id as string)); });
  router.post("/operations/:id/close", body(z.object({ confirmed: z.literal(true) }).strict()), (req, res) => {
    res.json(transfers.close(currentUserId(req), req.params.id as string));
  });
  router.get("/market", query(marketSchema), async (req, res) => {
    const input = res.locals.query as z.infer<typeof marketSchema>;
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await service.marketPreview(currentUserId(req), input.sourceAccountId, input.targetAccountId, input));
    } catch (error) {
      if (error instanceof GameClientError) throw new HttpError(502, "GAME_READ_FAILED", `读取游戏数据失败：${error.message}`);
      throw error;
    }
  });
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
  router.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
    next(error instanceof GameClientError ? new HttpError(502, "GAME_READ_FAILED", `读取游戏数据失败：${error.message}`) : error);
  });
  return router;
}
