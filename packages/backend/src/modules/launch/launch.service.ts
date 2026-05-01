import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { workspaces, workspaceMembers, userInstances, users } from "../../db/schema";
import { decrypt, randomHex } from "../../shared/crypto";
import { config } from "../../config";
import { provisionInstance, startInstance, instanceUrl, instanceWsUrl, caddyAddServer } from "../provisioning/provisioning.service";
import { NotFoundError, AppError } from "../../shared/errors";
import type { Workspace } from "../../db/schema";

const SECRET = config.JWT_ACCESS_SECRET;
const LAUNCH_TTL_MS = 5 * 60 * 1000;

function sign(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken<T extends object>(raw: string): T & { exp: number } {
  const dot = raw.lastIndexOf(".");
  if (dot < 1) throw new AppError(401, "Invalid launch token", "INVALID_TOKEN");
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new AppError(401, "Invalid launch token", "INVALID_TOKEN");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
  if (Date.now() > payload.exp) throw new AppError(401, "Launch token expired", "TOKEN_EXPIRED");
  return payload;
}

function emailToSlug(email: string): string {
  return (
    email
      .split("@")[0]!
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "user"
  );
}

async function getOrCreateWorkspace(userId: string, userEmail: string): Promise<Workspace> {
  const rows = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  if (rows.length > 0) return rows[0]!.workspace;

  const baseSlug = emailToSlug(userEmail);
  const conflict = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, baseSlug))
    .limit(1);
  const slug = conflict.length ? `${baseSlug}-${randomHex(2)}` : baseSlug;

  const [ws] = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(workspaces)
      .values({ name: slug, slug, ownerId: userId })
      .returning();
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: created!.id, userId, role: "owner" });
    return [created!];
  });

  return ws!;
}

export async function getLaunchUrl(userId: string): Promise<{ launchUrl: string }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError("User");

  const ws = await getOrCreateWorkspace(userId, user.email);

  const [existing] = await db
    .select()
    .from(userInstances)
    .where(eq(userInstances.workspaceId, ws.id))
    .limit(1);

  if (!existing || existing.status === "terminated") {
    await provisionInstance(ws.id);
  } else if (existing.status === "stopped") {
    await startInstance(ws.id);
  }

  // Re-fetch to get the port (may have just been set by provisionInstance)
  const [fresh] = await db
    .select()
    .from(userInstances)
    .where(eq(userInstances.workspaceId, ws.id))
    .limit(1);

  // Ensure Caddy route exists — idempotent PUT, self-heals after Caddy restarts.
  if (fresh && fresh.status !== "terminated") {
    await caddyAddServer(ws.slug, fresh.containerName, fresh.port).catch(() => {});
  }

  const token = sign({ userId, workspaceId: ws.id, exp: Date.now() + LAUNCH_TTL_MS });
  return { launchUrl: `${instanceUrl(fresh!.port)}/auth/launch?t=${token}` };
}

export async function resolveInjection(raw: string): Promise<{ plainToken: string; gwUrl: string }> {
  const { workspaceId } = verifyToken<{ userId: string; workspaceId: string }>(raw);

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw new NotFoundError("Workspace");

  const [instance] = await db
    .select()
    .from(userInstances)
    .where(eq(userInstances.workspaceId, workspaceId))
    .limit(1);

  if (!instance) throw new NotFoundError("Instance");
  if (instance.status !== "running") {
    throw new AppError(503, "Instance not ready yet, please try again in a moment", "INSTANCE_NOT_READY");
  }

  return { plainToken: decrypt(instance.gatewayToken), gwUrl: instanceWsUrl(instance.port) };
}
