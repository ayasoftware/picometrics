import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireWorkspaceMember, requireAdmin } from "../../middleware/workspace";
import * as ctrl from "./api-keys.controller";
import type { RequestHandler } from "express";

export const apiKeysRouter = Router();

const auth   = requireAuth as unknown as RequestHandler;
const member = requireWorkspaceMember as unknown as RequestHandler;
const admin  = requireAdmin as unknown as RequestHandler;

apiKeysRouter.get("/:workspaceId/api-keys",          auth, member, admin, ctrl.list as unknown as RequestHandler);
apiKeysRouter.post("/:workspaceId/api-keys",         auth, member, admin, ctrl.create as unknown as RequestHandler);
apiKeysRouter.delete("/:workspaceId/api-keys/:keyId", auth, member, admin, ctrl.revoke as unknown as RequestHandler);
