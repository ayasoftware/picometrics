import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { config } from "../../config";
import { UnauthorizedError } from "../../shared/errors";
import * as svc from "./provisioning.service";

export const provisioningRouter = Router();

function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.headers["x-internal-secret"] !== config.INTERNAL_API_SECRET) {
    return next(new UnauthorizedError("Admin access required"));
  }
  next();
}

provisioningRouter.use(requireAdmin);

// List all instances
provisioningRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await svc.listInstances());
  } catch (err) {
    next(err);
  }
});

// Get single instance status
provisioningRouter.get("/:workspaceId", async (req, res, next) => {
  try {
    res.json(await svc.getInstanceStatus(req.params.workspaceId!));
  } catch (err) {
    next(err);
  }
});

// Sync MCP config to all running instances — static route must precede /:workspaceId
provisioningRouter.post("/sync-mcp-all", async (_req, res, next) => {
  try {
    res.json(await svc.syncAllMcpConfigs());
  } catch (err) {
    next(err);
  }
});

// Upgrade all running instances at once — static route must precede /:workspaceId
provisioningRouter.post("/upgrade-all", async (req, res, next) => {
  try {
    const image = (req.body as { image?: string }).image ?? config.PROVISIONING_OPENCLAW_IMAGE;
    res.json(await svc.upgradeAllInstances(image));
  } catch (err) {
    next(err);
  }
});

// Provision new instance for workspace
provisioningRouter.post("/:workspaceId", async (req, res, next) => {
  try {
    const instance = await svc.provisionInstance(req.params.workspaceId!);
    res.status(201).json(instance);
  } catch (err) {
    next(err);
  }
});

// Start a stopped instance
provisioningRouter.post("/:workspaceId/start", async (req, res, next) => {
  try {
    res.json(await svc.startInstance(req.params.workspaceId!));
  } catch (err) {
    next(err);
  }
});

// Stop a running instance
provisioningRouter.post("/:workspaceId/stop", async (req, res, next) => {
  try {
    res.json(await svc.stopInstance(req.params.workspaceId!));
  } catch (err) {
    next(err);
  }
});

// Upgrade a single instance to a new image (default: PROVISIONING_OPENCLAW_IMAGE)
provisioningRouter.post("/:workspaceId/upgrade", async (req, res, next) => {
  try {
    const image = (req.body as { image?: string }).image ?? config.PROVISIONING_OPENCLAW_IMAGE;
    res.json(await svc.upgradeInstance(req.params.workspaceId!, image));
  } catch (err) {
    next(err);
  }
});

// Approve all pending device pairing requests
provisioningRouter.post("/:workspaceId/approve-devices", async (req, res, next) => {
  try {
    const approved = await svc.approveDevices(req.params.workspaceId!);
    res.json({ approved });
  } catch (err) {
    next(err);
  }
});

// Destroy instance + container
provisioningRouter.delete("/:workspaceId", async (req, res, next) => {
  try {
    await svc.destroyInstance(req.params.workspaceId!);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
