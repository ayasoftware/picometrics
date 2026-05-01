import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { config } from "../../config";
import { redis } from "../../redis";
import { db } from "../../db";
import { userInstances } from "../../db/schema";
import { decrypt } from "../../shared/crypto";
import { getDecryptedToken } from "../oauth/oauth.service";
import { AppError } from "../../shared/errors";
import { logger } from "../../shared/logger";
import type { OAuthProvider } from "../../shared/types";

export const mcpProxyRouter = Router();

const SERVICE_MAP: Record<string, { url: string; provider: OAuthProvider }> = {
  "gtm":              { url: config.MCP_GTM_URL,             provider: "google"   },
  "google-ads":       { url: config.MCP_GOOGLE_ADS_URL,       provider: "google"   },
  "linkedin-ads":     { url: config.MCP_LINKEDIN_ADS_URL,     provider: "linkedin" },
  "facebook-ads":     { url: config.MCP_FACEBOOK_ADS_URL,     provider: "facebook" },
  "google-analytics": { url: config.MCP_GOOGLE_ANALYTICS_URL, provider: "google"   },
};

// In-memory SSE session store: sessionId → open SSE Response
// Used to route MCP responses back through the SSE stream (old MCP SSE transport).
const sseSessions = new Map<string, Response>();

/**
 * Resolve workspaceId from a plain gateway token.
 * Fast path: Redis cache (populated at provisioning / backend startup).
 * Fallback path: decrypt all running instance tokens from DB (handles Redis data loss).
 * Re-populates Redis on a cache miss so subsequent calls are fast again.
 */
async function resolveWorkspaceId(gatewayToken: string): Promise<string | null> {
  const cached = await redis.get(`gw:${gatewayToken}`);
  if (cached) return cached;

  // Redis cache miss — scan running instances and try to match by decryption
  const rows = await db
    .select({ workspaceId: userInstances.workspaceId, gatewayToken: userInstances.gatewayToken })
    .from(userInstances)
    .where(eq(userInstances.status, "running"));

  for (const row of rows) {
    try {
      const plain = decrypt(row.gatewayToken);
      if (plain === gatewayToken) {
        await redis.set(`gw:${gatewayToken}`, row.workspaceId);
        logger.info({ workspaceId: row.workspaceId }, "Gateway token re-cached from DB after Redis miss");
        return row.workspaceId;
      }
    } catch {
      // wrong key or corrupt ciphertext — skip
    }
  }
  return null;
}

// GET /mcp-proxy/:service — SSE transport handshake (old MCP protocol)
// OpenClaw sends a GET first to establish the SSE stream and learn the POST endpoint.
mcpProxyRouter.get("/:service", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { service } = req.params;
    const svc = SERVICE_MAP[service!];
    if (!svc) throw new AppError(404, `Unknown MCP service: ${service}`, "UNKNOWN_SERVICE");

    const gatewayToken = req.headers["x-gateway-token"];
    if (typeof gatewayToken !== "string" || !gatewayToken) {
      throw new AppError(401, "Missing x-gateway-token", "MISSING_TOKEN");
    }

    const workspaceId = await resolveWorkspaceId(gatewayToken);
    if (!workspaceId) throw new AppError(401, "Invalid gateway token", "INVALID_TOKEN");

    const sessionId = randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    sseSessions.set(sessionId, res);

    const cleanup = () => sseSessions.delete(sessionId);
    req.on("close", cleanup);

    // Tell client where to POST messages (MCP SSE protocol: "endpoint" event)
    res.write(`event: endpoint\ndata: /mcp-proxy/${service}?sessionId=${encodeURIComponent(sessionId)}\n\n`);

    // Keepalive so proxies/load-balancers don't drop the idle connection
    const heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return; }
      res.write(": \n\n");
    }, 20_000);
    req.on("close", () => clearInterval(heartbeat));
  } catch (err) {
    next(err);
  }
});

// POST /mcp-proxy/:service — proxy MCP request to upstream; supports both SSE and Streamable HTTP
// Called by OpenClaw containers (via Docker network). Auth: x-gateway-token (plain token).
mcpProxyRouter.post("/:service", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { service } = req.params;
    const sessionId = req.query.sessionId as string | undefined;
    const svc = SERVICE_MAP[service!];
    if (!svc) throw new AppError(404, `Unknown MCP service: ${service}`, "UNKNOWN_SERVICE");

    const gatewayToken = req.headers["x-gateway-token"];
    if (typeof gatewayToken !== "string" || !gatewayToken) {
      throw new AppError(401, "Missing x-gateway-token", "MISSING_TOKEN");
    }

    // Fast lookup: workspaceId stored in Redis when instance was provisioned
    const workspaceId = await resolveWorkspaceId(gatewayToken);
    if (!workspaceId) throw new AppError(401, "Invalid gateway token", "INVALID_TOKEN");

    // initialize / tools/list / notifications/initialized don't call the upstream API —
    // they only negotiate capabilities.  Use a placeholder so OpenClaw can load the
    // server even before the user has connected their OAuth account.
    const method = (req.body as { method?: string } | undefined)?.method ?? "";
    const needsOAuth = method === "tools/call";

    const oauthToken = needsOAuth
      ? await getDecryptedToken(workspaceId, svc.provider)
      : (await getDecryptedToken(workspaceId, svc.provider)) ?? "__init__";

    if (needsOAuth && !oauthToken) {
      throw new AppError(503, `${svc.provider} account not connected`, "OAUTH_NOT_CONNECTED");
    }

    // Proxy to upstream MCP server — pass body as-is (already parsed by express.json)
    const upstream = await fetch(`${svc.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-internal-secret": config.INTERNAL_API_SECRET,
        "x-workspace-token": oauthToken,
      },
      body: JSON.stringify(req.body),
    });

    const sseClient = sessionId ? sseSessions.get(sessionId) : undefined;

    if (sseClient && !sseClient.writableEnded) {
      // SSE transport: route the upstream response back through the open SSE stream
      const contentType = upstream.headers.get("content-type") ?? "";

      if (contentType.includes("text/event-stream")) {
        // Upstream replied with SSE — forward each data line as an SSE message event
        const text = await upstream.text();
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data && data !== "[DONE]") {
              sseClient.write(`event: message\ndata: ${data}\n\n`);
            }
          }
        }
      } else {
        // Upstream replied with JSON — forward as a single SSE message event
        const text = await upstream.text();
        if (text.trim()) {
          sseClient.write(`event: message\ndata: ${text.trim()}\n\n`);
        }
      }

      // Acknowledge POST with no body (MCP SSE transport expects 202)
      res.status(202).end();
    } else {
      // Streamable HTTP transport (no session) — respond directly to the POST
      res.status(upstream.status);

      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const cc = upstream.headers.get("cache-control");
      if (cc) res.setHeader("Cache-Control", cc);

      if (!upstream.body) {
        res.end();
        return;
      }

      // Pipe upstream response (may be SSE or plain JSON) directly to client without buffering
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeline(Readable.fromWeb(upstream.body as any), res);
    }
  } catch (err) {
    if (err instanceof AppError) {
      // Log at debug level — these are expected auth errors from containers
      logger.debug({ err, service: req.params.service }, "MCP proxy error");
    } else {
      logger.warn({ err, service: req.params.service }, "MCP proxy upstream error");
    }
    next(err);
  }
});
