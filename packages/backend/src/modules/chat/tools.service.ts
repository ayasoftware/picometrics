import { redis } from "../../redis";
import { config } from "../../config";
import { logger } from "../../shared/logger";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { oauthTokens, userMcpSelections } from "../../db/schema";
import { allMcpServers, MCP_SERVERS } from "./mcp.registry";
import type { OAuthProvider } from "../../shared/types";

const CACHE_TTL = 60; // seconds

interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * Returns the merged set of OpenAI function-call tool schemas for all
 * OAuth providers connected to the given workspace.
 * Results are cached in Redis for 60 seconds to avoid per-request MCP round-trips.
 */
export async function getWorkspaceTools(workspaceId: string): Promise<OpenAITool[]> {
  const cacheKey = `tools:${workspaceId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as OpenAITool[];

  // Find which providers are connected for this workspace
  const connections = await db
    .select({ provider: oauthTokens.provider })
    .from(oauthTokens)
    .where(eq(oauthTokens.workspaceId, workspaceId));

  const connectedProviders = new Set(connections.map((c) => c.provider as OAuthProvider));

  const allTools: OpenAITool[] = [];

  await Promise.allSettled(
    allMcpServers().map(async ({ url, provider }) => {
      if (!connectedProviders.has(provider)) return; // skip unconnected
      try {
        const res = await fetch(`${url}/tool-schemas`, {
          headers: { "x-internal-secret": config.INTERNAL_API_SECRET },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const schemas = (await res.json()) as OpenAITool[];
        allTools.push(...schemas);
      } catch (err) {
        logger.warn({ err, url }, "Failed to fetch tool schemas from MCP server");
      }
    }),
  );

  await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(allTools));
  return allTools;
}

/** Invalidate the tool cache for a workspace (call after OAuth connect/disconnect) */
export async function invalidateToolCache(workspaceId: string): Promise<void> {
  await redis.del(`tools:${workspaceId}`);
}

/**
 * Returns tool schemas for a specific user based on their MCP selections.
 * If the user has no selections saved yet, all MCP servers are included by default.
 */
export async function getUserTools(userId: string): Promise<OpenAITool[]> {
  const cacheKey = `user-tools:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as OpenAITool[];

  const selections = await db
    .select()
    .from(userMcpSelections)
    .where(eq(userMcpSelections.userId, userId));

  // No prefs saved → include all servers by default
  let servers = MCP_SERVERS;
  if (selections.length > 0) {
    const enabledIds = new Set(
      selections.filter((s) => s.enabled).map((s) => s.mcpServerId),
    );
    servers = MCP_SERVERS.filter((s) => enabledIds.has(s.id));
  }

  const allTools: OpenAITool[] = [];
  await Promise.allSettled(
    servers.map(async ({ url }) => {
      try {
        const res = await fetch(`${url}/tool-schemas`, {
          headers: { "x-internal-secret": config.INTERNAL_API_SECRET },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        allTools.push(...((await res.json()) as OpenAITool[]));
      } catch (err) {
        logger.warn({ err, url }, "Failed to fetch tool schemas from MCP server");
      }
    }),
  );

  await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(allTools));
  return allTools;
}

/** Invalidate the user-level tool cache (call after MCP selection changes) */
export async function invalidateUserToolCache(userId: string): Promise<void> {
  await redis.del(`user-tools:${userId}`);
}
