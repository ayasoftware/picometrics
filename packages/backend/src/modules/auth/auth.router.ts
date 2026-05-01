import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import * as ctrl from "./auth.controller";
import type { AuthenticatedRequest } from "../../shared/types";
import type { RequestHandler } from "express";

export const authRouter = Router();

authRouter.post("/register", ctrl.register as unknown as RequestHandler);
authRouter.post("/login",    ctrl.login as unknown as RequestHandler);
authRouter.post("/refresh",  ctrl.refresh as unknown as RequestHandler);
authRouter.post("/logout",   ctrl.logout as unknown as RequestHandler);
authRouter.post("/logout-all", requireAuth as unknown as RequestHandler, ctrl.logoutAll as unknown as RequestHandler);
authRouter.get("/me",        requireAuth as unknown as RequestHandler, ctrl.me as unknown as RequestHandler);
authRouter.patch("/me",      requireAuth as unknown as RequestHandler, ctrl.updateMe as unknown as RequestHandler);
