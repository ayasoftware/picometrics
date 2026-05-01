import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { userMcpSelections } from "../../db/schema";
import { MCP_SERVERS } from "../chat/mcp.registry";
import { invalidateUserToolCache } from "../chat/tools.service";

export async function getUserMcpSelections(userId: string) {
  const rows = await db
    .select()
    .from(userMcpSelections)
    .where(eq(userMcpSelections.userId, userId));

  const savedMap = new Map(rows.map((r) => [r.mcpServerId, r.enabled]));

  // Return all known servers; if user has no saved preference, default to enabled
  return MCP_SERVERS.map((s) => ({
    id:      s.id,
    name:    s.name,
    enabled: savedMap.has(s.id) ? savedMap.get(s.id)! : true,
  }));
}

export async function upsertUserMcpSelections(
  userId: string,
  selections: { id: string; enabled: boolean }[],
): Promise<void> {
  const validIds = new Set(MCP_SERVERS.map((s) => s.id));
  const valid = selections.filter((s) => validIds.has(s.id));

  await db.transaction(async (tx) => {
    for (const { id, enabled } of valid) {
      await tx
        .insert(userMcpSelections)
        .values({ userId, mcpServerId: id, enabled })
        .onConflictDoUpdate({
          target: [userMcpSelections.userId, userMcpSelections.mcpServerId],
          set: { enabled, updatedAt: new Date() },
        });
    }
  });

  await invalidateUserToolCache(userId);
}
