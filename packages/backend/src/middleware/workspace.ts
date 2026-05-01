import type { Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { workspaceMembers } from "../db/schema";
import { ForbiddenError, UnauthorizedError } from "../shared/errors";
import type { AuthenticatedRequest, WorkspaceRole } from "../shared/types";

/**
 * Resolves the workspace from :workspaceId param, verifies the user is a member,
 * and attaches req.workspaceId + req.workspaceRole.
 */
export function requireWorkspaceMember(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const workspaceId = req.params.workspaceId ?? req.workspaceId;
  if (!workspaceId) return next(new UnauthorizedError("Workspace not specified"));

  // open-webui synthetic user skips membership check (proxy auth is handled differently)
  if (req.userId === "open-webui") {
    req.workspaceId = workspaceId;
    return next();
  }

  db.select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId)))
    .limit(1)
    .then(([member]) => {
      if (!member) return next(new ForbiddenError("Not a workspace member"));
      req.workspaceId = workspaceId;
      req.workspaceRole = member.role as WorkspaceRole;
      next();
    })
    .catch(next);
}

/** Require at least admin role */
export function requireAdmin(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  if (!["owner", "admin"].includes(req.workspaceRole ?? "")) return next(new ForbiddenError("Admin role required"));
  next();
}

/** Require owner role */
export function requireOwner(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  if (req.workspaceRole !== "owner") return next(new ForbiddenError("Owner role required"));
  next();
}
