import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { config } from "./config";
import { logger } from "./shared/logger";
import { redis } from "./redis";
import { errorHandler } from "./middleware/errorHandler";

// Route imports (added progressively per phase)
import { authRouter } from "./modules/auth/auth.router";
import { workspaceRouter } from "./modules/workspace/workspace.router";
import { apiKeysRouter } from "./modules/api-keys/api-keys.router";
import { oauthRouter, oauthCallbackRouter } from "./modules/oauth/oauth.router";
import { chatRouter } from "./modules/chat/chat.router";
import { llmConfigRouter } from "./modules/llm-config/llm-config.router";
import { mcpSelectionsRouter } from "./modules/mcp-selections/mcp-selections.router";
import { settingsRouter } from "./modules/settings/settings.router";
import { provisioningRouter } from "./modules/provisioning/provisioning.router";
import { launchRouter } from "./modules/launch/launch.router";
import { mcpProxyRouter } from "./modules/mcp-proxy/mcp-proxy.router";
import { platformConfigRouter } from "./modules/platform-config/platform-config.router";
import { mcpConfigsRouter } from "./modules/mcp-configs/mcp-configs.router";
import { instanceRouter } from "./modules/instance/instance.router";
import { restoreCaddyRoutes } from "./modules/provisioning/provisioning.service";

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

// ── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── Routes ──────────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/workspaces", workspaceRouter);
app.use("/api/workspaces", apiKeysRouter);
app.use("/api/workspaces", oauthRouter);
app.use("/api/oauth", oauthCallbackRouter);   // provider redirect target
app.use("/api/users", llmConfigRouter);         // per-user LLM config
app.use("/api/users", mcpSelectionsRouter);     // per-user MCP selections
app.use("/v1", chatRouter);                    // OpenAI-compatible proxy
app.use("/", settingsRouter);                  // User settings page
app.use("/admin/provision", provisioningRouter); // Admin: per-workspace container management
app.use("/api/admin", platformConfigRouter);     // Admin: OAuth app credentials
app.use("/api/workspaces/:workspaceId/mcp-configs", mcpConfigsRouter); // Per-workspace MCP config CRUD
app.use("/api/workspaces", instanceRouter);                            // Per-workspace instance status + upgrade
app.use("/mcp-proxy", mcpProxyRouter);           // MCP proxy for OpenClaw containers
app.use("/", launchRouter);                    // Public portal + instance token injection

// ── Error handler (must be last) ────────────────────────────────────────────
app.use(errorHandler);

// ── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await redis.connect();
  app.listen(config.PORT, () => {
    logger.info(`Backend listening on port ${config.PORT}`);
  });
  // Caddy dynamic config is in-memory; restore all running instance routes after restart.
  // Delay to let Caddy finish initializing its HTTP module before we write to the admin API.
  setTimeout(() => {
    restoreCaddyRoutes().catch((err) => logger.warn({ err }, "Caddy route restoration failed"));
  }, 5000);
}

start().catch((err) => {
  logger.error({ err }, "Failed to start");
  process.exit(1);
});
