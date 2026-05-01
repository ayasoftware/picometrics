import { Router } from "express";
import type { Response, NextFunction, RequestHandler } from "express";
import { requireAuth } from "../../middleware/auth";
import { getUserMcpSelections, upsertUserMcpSelections } from "./mcp-selections.service";
import type { AuthenticatedRequest } from "../../shared/types";

export const mcpSelectionsRouter = Router();

mcpSelectionsRouter.use(requireAuth as unknown as RequestHandler);

/** GET /api/users/me/mcp-selections — list all MCP servers with enabled/disabled status */
mcpSelectionsRouter.get("/me/mcp-selections", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const selections = await getUserMcpSelections(req.userId);
    res.json(selections);
  } catch (err) {
    next(err);
  }
}) as unknown as RequestHandler);

/** PUT /api/users/me/mcp-selections — update which MCPs are enabled
 *  Body: { selections: [{ id: string, enabled: boolean }] }
 */
mcpSelectionsRouter.put("/me/mcp-selections", (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { selections } = req.body as { selections?: { id: string; enabled: boolean }[] };
    if (!Array.isArray(selections)) {
      res.status(422).json({ error: { code: "VALIDATION_ERROR", message: "selections array required" } });
      return;
    }
    await upsertUserMcpSelections(req.userId, selections);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}) as unknown as RequestHandler);
