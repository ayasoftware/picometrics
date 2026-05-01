import { Router } from "express";
import type { Response, NextFunction, RequestHandler } from "express";
import { requireAuth } from "../../middleware/auth";
import { listPlatformConfigs, setPlatformConfig, deletePlatformConfig, isAllowedKey } from "./platform-config.service";
import { AppError } from "../../shared/errors";
import type { AuthenticatedRequest } from "../../shared/types";

export const platformConfigRouter = Router();

platformConfigRouter.use(requireAuth as unknown as RequestHandler);

platformConfigRouter.get("/platform-config", (async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ configs: await listPlatformConfigs() });
  } catch (err) { next(err); }
}) as unknown as RequestHandler);

platformConfigRouter.put("/platform-config", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { key, value } = req.body as { key?: string; value?: string };
    if (!key || !value?.trim()) {
      res.status(422).json({ error: { code: "VALIDATION_ERROR", message: "key and value are required" } });
      return;
    }
    if (!isAllowedKey(key)) {
      throw new AppError(422, `Unknown config key: ${key}`, "VALIDATION_ERROR");
    }
    await setPlatformConfig(key, value.trim());
    res.json({ ok: true });
  } catch (err) { next(err); }
}) as unknown as RequestHandler);

platformConfigRouter.delete("/platform-config", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const key = req.query.key as string | undefined;
    if (!key || !isAllowedKey(key)) {
      throw new AppError(422, `Unknown config key: ${key}`, "VALIDATION_ERROR");
    }
    await deletePlatformConfig(key);
    res.json({ ok: true });
  } catch (err) { next(err); }
}) as unknown as RequestHandler);
