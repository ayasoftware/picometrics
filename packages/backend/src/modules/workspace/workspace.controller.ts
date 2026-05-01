import type { Response, NextFunction } from "express";
import * as svc from "./workspace.service";
import type { AuthenticatedRequest } from "../../shared/types";

export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const ws = await svc.createWorkspace(req.userId, req.body);
    res.status(201).json(ws);
  } catch (err) { next(err); }
}

export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await svc.listWorkspacesForUser(req.userId));
  } catch (err) { next(err); }
}

export async function get(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await svc.getWorkspace(req.workspaceId!));
  } catch (err) { next(err); }
}

export async function update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await svc.updateWorkspace(req.workspaceId!, req.body));
  } catch (err) { next(err); }
}

export async function remove(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await svc.deleteWorkspace(req.workspaceId!);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

export async function listMembers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await svc.listMembers(req.workspaceId!));
  } catch (err) { next(err); }
}

export async function inviteMember(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { email, role = "member" } = req.body;
    res.status(201).json(await svc.inviteMember(req.workspaceId!, req.userId, email, role));
  } catch (err) { next(err); }
}

export async function updateMember(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await svc.updateMemberRole(req.workspaceId!, req.params.userId!, req.body.role));
  } catch (err) { next(err); }
}

export async function removeMember(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await svc.removeMember(req.workspaceId!, req.params.userId!, req.workspaceRole!);
    res.json({ ok: true });
  } catch (err) { next(err); }
}
