import rateLimit from "express-rate-limit";
import type { Request } from "express";
import type { AuthenticatedRequest } from "../shared/types";

/** General API rate limit: 120 req/min per IP */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req as AuthenticatedRequest).userId ?? req.ip ?? "unknown",
  message: { error: { code: "RATE_LIMITED", message: "Too many requests, slow down" } },
});

/** Chat proxy rate limit: 20 req/min per workspace */
export const chatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).workspaceId ?? (req as AuthenticatedRequest).userId ?? req.ip ?? "unknown",
  message: { error: { code: "RATE_LIMITED", message: "Chat rate limit exceeded" } },
});
