import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireWorkspaceMember, requireAdmin, requireOwner } from "../../middleware/workspace";
import * as ctrl from "./workspace.controller";
import type { RequestHandler } from "express";

export const workspaceRouter = Router();

const auth = requireAuth as unknown as RequestHandler;
const member = requireWorkspaceMember as unknown as RequestHandler;
const admin = requireAdmin as unknown as RequestHandler;
const owner = requireOwner as unknown as RequestHandler;

workspaceRouter.get("/",                                          auth, ctrl.list as unknown as RequestHandler);
workspaceRouter.post("/",                                         auth, ctrl.create as unknown as RequestHandler);
workspaceRouter.get("/:workspaceId",                              auth, member, ctrl.get as unknown as RequestHandler);
workspaceRouter.patch("/:workspaceId",                            auth, member, admin, ctrl.update as unknown as RequestHandler);
workspaceRouter.delete("/:workspaceId",                           auth, member, owner, ctrl.remove as unknown as RequestHandler);
workspaceRouter.get("/:workspaceId/members",                      auth, member, ctrl.listMembers as unknown as RequestHandler);
workspaceRouter.post("/:workspaceId/members",                     auth, member, admin, ctrl.inviteMember as unknown as RequestHandler);
workspaceRouter.patch("/:workspaceId/members/:userId",            auth, member, admin, ctrl.updateMember as unknown as RequestHandler);
workspaceRouter.delete("/:workspaceId/members/:userId",           auth, member, admin, ctrl.removeMember as unknown as RequestHandler);
