import type { Response, NextFunction } from "express";
import { verifyAccessToken } from "../modules/auth/token.service";
import { UnauthorizedError } from "../shared/errors";
import type { AuthenticatedRequest } from "../shared/types";

export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(new UnauthorizedError());
  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    next();
  } catch (err) {
    next(err);
  }
}
