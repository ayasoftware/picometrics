import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireWorkspaceMember, requireAdmin } from "../../middleware/workspace";
import * as ctrl from "./oauth.controller";
import type { RequestHandler } from "express";

// Mounted at /api/workspaces
export const oauthRouter = Router();

const auth   = requireAuth as unknown as RequestHandler;
const member = requireWorkspaceMember as unknown as RequestHandler;
const admin  = requireAdmin as unknown as RequestHandler;

oauthRouter.get("/:workspaceId/oauth/connections",        auth, member, ctrl.listConnections as unknown as RequestHandler);
oauthRouter.get("/:workspaceId/oauth/:provider/authorize", auth, member, admin, ctrl.authorize as unknown as RequestHandler);
oauthRouter.delete("/:workspaceId/oauth/:provider",        auth, member, admin, ctrl.disconnect as unknown as RequestHandler);

// Mounted at /api/oauth — provider redirects here (no auth middleware needed)
export const oauthCallbackRouter = Router();
oauthCallbackRouter.get("/callback/:provider", ctrl.callback as unknown as RequestHandler);
