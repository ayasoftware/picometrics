import type { Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, users, workspaces, workspaceMembers } from "../db/schema";
import { sha256 } from "../shared/crypto";
import { config } from "../config";
import { redis } from "../redis";
import type { AuthenticatedRequest } from "../shared/types";

/**
 * Accepts either:
 *   Authorization: Bearer <JWT>       (handled by requireAuth)
 *   Authorization: Bearer mak_<key>   (handled here)
 *   Authorization: Bearer <OPEN_WEBUI_API_KEY>  (Open WebUI proxy)
 *
 * For the Open WebUI key, reads X-OpenWebUI-User-Email to identify the real
 * user and auto-provisions them (user + personal workspace) on first request.
 */
export async function resolveApiKey(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();

  const token = header.slice(7);

  if (token === config.OPEN_WEBUI_API_KEY) {
    const email = (req.headers["x-openwebui-user-email"] as string | undefined)?.toLowerCase().trim();
    const name  = (req.headers["x-openwebui-user-name"]  as string | undefined) ?? email ?? "User";

    if (email) {
      try {
        const { userId, workspaceId } = await provisionOpenWebUIUser(email, name);
        req.userId = userId;
        req.workspaceId = workspaceId;
      } catch {
        req.userId = "open-webui";
      }
    } else {
      req.userId = "open-webui";
      const wsId = req.headers["x-workspace-id"] as string | undefined;
      if (wsId) req.workspaceId = wsId;
    }
    return next();
  }

  if (token.startsWith("mak_")) {
    const hash = sha256(token);
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.revoked, false)))
      .limit(1);

    if (key && (!key.expiresAt || key.expiresAt > new Date())) {
      req.userId = key.createdBy;
      req.workspaceId = key.workspaceId;
      db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
    }
  }

  next();
}

/** Find-or-create a user + their personal workspace. Result is cached in Redis. */
async function provisionOpenWebUIUser(
  email: string,
  name: string,
): Promise<{ userId: string; workspaceId: string }> {
  const cacheKey = `owui-user:${email}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as { userId: string; workspaceId: string };

  // Find existing user
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user) {
    // Create user (no password — they log in via Open WebUI only)
    [user] = await db
      .insert(users)
      .values({ email, fullName: name })
      .returning();
  }

  // Find or create their personal workspace
  const slug = `personal-${user!.id.slice(0, 8)}`;
  let [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, user!.id), eq(workspaceMembers.role, "owner")))
    .limit(1);

  if (!ws) {
    await db.transaction(async (tx) => {
      const [newWs] = await tx
        .insert(workspaces)
        .values({ name: "Personal", slug, ownerId: user!.id })
        .returning();
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: newWs!.id, userId: user!.id, role: "owner" });
      ws = { id: newWs!.id };
    });
  }

  const result = { userId: user!.id, workspaceId: ws!.id };
  // Cache for 1 hour — invalidate if user is deleted
  await redis.setex(cacheKey, 3600, JSON.stringify(result));
  return result;
}
