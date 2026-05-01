import { Router } from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireWorkspaceMember, requireAdmin } from "../../middleware/workspace";
import * as svc from "./mcp-configs.service";
import { syncMcpConfigToContainer } from "../provisioning/provisioning.service";
import type { AuthenticatedRequest } from "../../shared/types";

export const mcpConfigsRouter = Router({ mergeParams: true });

const auth   = requireAuth              as unknown as RequestHandler;
const member = requireWorkspaceMember   as unknown as RequestHandler;
const admin  = requireAdmin             as unknown as RequestHandler;

// GET /api/workspaces/:workspaceId/mcp-configs
mcpConfigsRouter.get(
  "/",
  auth, member,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      const configs = await svc.listMcpConfigs(workspaceId);
      res.json(configs);
    } catch (err) { next(err); }
  },
);

// POST /api/workspaces/:workspaceId/mcp-configs
mcpConfigsRouter.post(
  "/",
  auth, member, admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      const result = await svc.createMcpConfig(workspaceId, req.body as svc.McpConfigInput);
      res.status(201).json(result);
    } catch (err) { next(err); }
  },
);

// PUT /api/workspaces/:workspaceId/mcp-configs/:id
mcpConfigsRouter.put(
  "/:id",
  auth, member, admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      const result = await svc.updateMcpConfig(
        workspaceId,
        req.params.id!,
        req.body as Partial<svc.McpConfigInput>,
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// DELETE /api/workspaces/:workspaceId/mcp-configs/:id
mcpConfigsRouter.delete(
  "/:id",
  auth, member, admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      await svc.deleteMcpConfig(workspaceId, req.params.id!);
      res.status(204).end();
    } catch (err) { next(err); }
  },
);

// POST /api/workspaces/:workspaceId/mcp-configs/sync
// Force-regenerates openclaw.json and restarts the container.
mcpConfigsRouter.post(
  "/sync",
  auth, member, admin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      await syncMcpConfigToContainer(workspaceId);
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// GET /api/workspaces/:workspaceId/mcp-configs/:id/health
mcpConfigsRouter.get(
  "/:id/health",
  auth, member,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = (req as AuthenticatedRequest).workspaceId!;
      const health = await svc.getMcpHealth(workspaceId, req.params.id!);
      res.json(health);
    } catch (err) { next(err); }
  },
);
