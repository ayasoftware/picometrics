import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { apiKeys } from "../../db/schema";
import { randomHex, sha256 } from "../../shared/crypto";
import { NotFoundError } from "../../shared/errors";

export async function createApiKey(workspaceId: string, createdBy: string, name: string) {
  const raw = `mak_${randomHex(24)}`; // 49-char key
  const hash = sha256(raw);
  const prefix = raw.slice(0, 12);

  const [key] = await db
    .insert(apiKeys)
    .values({ workspaceId, createdBy, name, keyPrefix: prefix, keyHash: hash })
    .returning();

  // Return the full key ONCE — it is not stored in plain text
  return { ...key!, key: raw };
}

export async function listApiKeys(workspaceId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revoked: apiKeys.revoked,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.revoked, false)));
}

export async function revokeApiKey(workspaceId: string, keyId: string) {
  const [key] = await db
    .update(apiKeys)
    .set({ revoked: true })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)))
    .returning();
  if (!key) throw new NotFoundError("API key");
}
