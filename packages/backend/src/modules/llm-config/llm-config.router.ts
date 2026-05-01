import { Router } from "express";
import type { Response, NextFunction, RequestHandler } from "express";
import { requireAuth } from "../../middleware/auth";
import { getAllUserLlmConfigs, upsertUserLlmConfig, deleteUserLlmConfig } from "./llm-config.service";
import { syncOpenClawAuthProfiles } from "../provisioning/provisioning.service";
import type { AuthenticatedRequest } from "../../shared/types";

export const llmConfigRouter = Router();

llmConfigRouter.use(requireAuth as unknown as RequestHandler);

/**
 * GET /api/users/me/llm-config
 * Returns all provider configs the user has saved (no raw API keys).
 */
llmConfigRouter.get("/me/llm-config", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const configs = await getAllUserLlmConfigs(req.userId);
    res.json({ configs });
  } catch (err) {
    next(err);
  }
}) as unknown as RequestHandler);

/**
 * PUT /api/users/me/llm-config
 * Save or update API key + model for a specific provider.
 * Body: { provider: "openai"|"anthropic"|"google", apiKey: string, model: string }
 */
llmConfigRouter.put("/me/llm-config", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { provider, apiKey, model } = req.body as { provider?: string; apiKey?: string; model?: string };
    if (!provider || !apiKey || !model) {
      res.status(422).json({ error: { code: "VALIDATION_ERROR", message: "provider, apiKey, and model are required" } });
      return;
    }
    await upsertUserLlmConfig(req.userId, provider, apiKey, model);
    syncOpenClawAuthProfiles(req.userId).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}) as unknown as RequestHandler);

/**
 * DELETE /api/users/me/llm-config?provider=openai
 * Removes the user's LLM config for a specific provider (or all if provider omitted).
 */
llmConfigRouter.delete("/me/llm-config", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const provider = req.query.provider as string | undefined;
    await deleteUserLlmConfig(req.userId, provider);
    syncOpenClawAuthProfiles(req.userId).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}) as unknown as RequestHandler);
