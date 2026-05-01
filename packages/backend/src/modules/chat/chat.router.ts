import { Router } from "express";
import type { Response, NextFunction } from "express";
import { resolveApiKey } from "../../middleware/apiKey";
import { requireAuth } from "../../middleware/auth";
import { UnauthorizedError } from "../../shared/errors";
import { runAgenticLoop } from "./chat.service";
import { resolveUserLlmConfig } from "../llm-config/llm-config.service";
import type { AuthenticatedRequest } from "../../shared/types";
import type { RequestHandler } from "express";

export const chatRouter = Router();

// Auth: accept JWT or API key (including the static Open WebUI key)
chatRouter.use(resolveApiKey as unknown as RequestHandler);

/**
 * POST /v1/chat/completions
 * OpenAI-compatible endpoint with agentic tool-call loop.
 */
chatRouter.post("/chat/completions", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) throw new UnauthorizedError();

    const workspaceId =
      req.workspaceId ??
      (req.headers["x-workspace-id"] as string | undefined) ??
      (req.body.workspace_id as string | undefined) ??
      "default";

    const { messages, stream = false, model } = req.body as { messages: unknown; stream?: boolean; model?: string };
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(422).json({ error: { code: "VALIDATION_ERROR", message: "messages array is required" } });
      return;
    }

    const sessionId = (req.body.session_id as string | undefined) ?? (req.headers["x-session-id"] as string | undefined);

    await runAgenticLoop(workspaceId, req.userId, messages as never[], Boolean(stream), res, sessionId, model);
  } catch (err) {
    next(err);
  }
}) as unknown as RequestHandler);

/**
 * GET /v1/models
 * Returns available models based on the authenticated user's configured provider.
 * Open WebUI uses this to populate the model picker.
 */
chatRouter.get("/models", (async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const allModels: { id: string; object: string; owned_by: string }[] = [
      { id: "gpt-4o",                    object: "model", owned_by: "openai" },
      { id: "gpt-4o-mini",               object: "model", owned_by: "openai" },
      { id: "gpt-4-turbo",               object: "model", owned_by: "openai" },
      { id: "claude-opus-4-7",           object: "model", owned_by: "anthropic" },
      { id: "claude-sonnet-4-6",         object: "model", owned_by: "anthropic" },
      { id: "claude-haiku-4-5-20251001", object: "model", owned_by: "anthropic" },
      { id: "gemini-2.0-flash",          object: "model", owned_by: "google" },
      { id: "gemini-1.5-pro",            object: "model", owned_by: "google" },
      { id: "gemini-1.5-flash",          object: "model", owned_by: "google" },
    ];
    res.json({ object: "list", data: allModels });
  } catch (err) {
    next(err);
  }
}) as unknown as RequestHandler);
