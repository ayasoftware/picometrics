import type { Response, NextFunction } from "express";
import * as svc from "./api-keys.service";
import type { AuthenticatedRequest } from "../../shared/types";

export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const key = await svc.createApiKey(req.workspaceId!, req.userId, req.body.name);
    res.status(201).json(key);
  } catch (err) { next(err); }
}

export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await svc.listApiKeys(req.workspaceId!));
  } catch (err) { next(err); }
}

export async function revoke(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await svc.revokeApiKey(req.workspaceId!, req.params.keyId!);
    res.json({ ok: true });
  } catch (err) { next(err); }
}
