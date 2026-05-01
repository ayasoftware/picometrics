import type { Request, Response, NextFunction } from "express";
import * as svc from "./oauth.service";
import { syncMcpConfigToContainer } from "../provisioning/provisioning.service";
import type { AuthenticatedRequest } from "../../shared/types";
import type { OAuthProvider } from "../../shared/types";

export async function authorize(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const provider = req.params.provider as OAuthProvider;
    const url = await svc.getAuthorizationUrl(req.workspaceId!, req.userId, provider);
    res.json({ url });
  } catch (err) { next(err); }
}

export async function callback(req: Request, res: Response, next: NextFunction) {
  try {
    const provider = req.params.provider as OAuthProvider;
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      res.redirect(`/user-settings?oauth_error=${encodeURIComponent(error)}`);
      return;
    }

    const { workspaceId } = await svc.handleCallback(provider, code, state);
    // Restart OpenClaw container in background so MCP servers reload with the fresh token
    syncMcpConfigToContainer(workspaceId).catch(() => {});
    res.redirect(`/user-settings?oauth_success=${provider}`);
  } catch (err) {
    next(err);
  }
}

export async function listConnections(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await svc.listConnections(req.workspaceId!));
  } catch (err) { next(err); }
}

export async function disconnect(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const provider = req.params.provider as OAuthProvider;
    await svc.disconnectProvider(req.workspaceId!, provider);
    res.json({ ok: true });
  } catch (err) { next(err); }
}
