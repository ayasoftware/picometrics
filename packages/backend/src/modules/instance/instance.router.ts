import { Router } from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireWorkspaceMember, requireAdmin } from "../../middleware/workspace";
import { getUserInstanceStatus, upgradeInstance } from "../provisioning/provisioning.service";
import { config } from "../../config";
import type { AuthenticatedRequest } from "../../shared/types";

export const instanceRouter = Router();

const auth   = requireAuth            as unknown as RequestHandler;
const member = requireWorkspaceMember as unknown as RequestHandler;
const admin  = requireAdmin           as unknown as RequestHandler;

// GET /api/workspaces/:workspaceId/instance/status
// Returns current image, suggested image, and upgradeAvailable flag.
instanceRouter.get(
  "/:workspaceId/instance/status",
  auth, member,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      const status = await getUserInstanceStatus(workspaceId);
      if (!status) { res.status(404).json({ error: { message: "No instance found" } }); return; }
      res.json(status);
    } catch (err) { next(err); }
  },
);

// POST /api/workspaces/:workspaceId/instance/upgrade
// Upgrades the container to the currently configured PROVISIONING_OPENCLAW_IMAGE.
// Owners and admins only — this restarts the container (brief downtime).
instanceRouter.post(
  "/:workspaceId/instance/upgrade",
  auth, member, admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      const image = config.PROVISIONING_OPENCLAW_IMAGE;
      await upgradeInstance(workspaceId, image);
      // Return refreshed status so the frontend can update the displayed version
      const status = await getUserInstanceStatus(workspaceId);
      res.json({ ok: true, ...status });
    } catch (err) { next(err); }
  },
);
