import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { userMcpConfigs } from "../../db/schema";
import { encrypt } from "../../shared/crypto";
import { NotFoundError, ConflictError, AppError } from "../../shared/errors";
import { syncMcpConfigToContainer, checkMcpContainerHealth } from "../provisioning/provisioning.service";
import { logger } from "../../shared/logger";

// ── Package allowlist ──────────────────────────────────────────────────────────
// Known-safe MCP package names for stdio transport.
// Packages NOT in this list are still accepted but generate a warning log so
// operators can review before approving use in production.
export const ALLOWED_MCP_PACKAGES = new Set([
  "@modelcontextprotocol/server-google-ads",
  "@modelcontextprotocol/server-google-analytics",
  "@modelcontextprotocol/server-facebook-ads",
  "@modelcontextprotocol/server-gtm",
  "@modelcontextprotocol/server-linkedin-ads",
]);

// Matches scoped (@scope/name) and unscoped (name) npm package names with
// optional semver tag (@1.2.3).  Rejects path traversal and shell metacharacters.
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[0-9]+\.[0-9]+\.[0-9]+)?$/;

// Any individual arg may only contain characters safe for shell single-quoting.
// Single quotes are excluded — base64 is used for the final config write so this
// constraint applies only to the allowlist validation step.
const SAFE_ARG_RE = /^[a-zA-Z0-9@/:._=~-]+$/;

const ALLOWED_COMMANDS = new Set(["npx", "node", "deno", "bun"]);

// ── Validation ─────────────────────────────────────────────────────────────────

export type McpConfigInput = {
  name: string;
  transport: string;
  command?: string | null;
  url?: string | null;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

function validateMcpInput(data: McpConfigInput): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(data.name)) {
    throw new AppError(400, "name must be lowercase alphanumeric with hyphens, 1–63 chars", "VALIDATION_ERROR");
  }
  if (!["stdio", "sse", "http"].includes(data.transport)) {
    throw new AppError(400, "transport must be stdio, sse, or http", "VALIDATION_ERROR");
  }

  if (data.transport === "stdio") {
    if (!data.command) {
      throw new AppError(400, "command is required for stdio transport", "VALIDATION_ERROR");
    }
    if (!ALLOWED_COMMANDS.has(data.command)) {
      throw new AppError(
        400,
        `command must be one of: ${[...ALLOWED_COMMANDS].join(", ")}`,
        "VALIDATION_ERROR",
      );
    }

    const args = data.args ?? [];
    if (!args.length) {
      throw new AppError(400, "args must not be empty for stdio transport", "VALIDATION_ERROR");
    }

    // Locate the package name: first arg that is not a flag
    const pkgArg = args.find((a) => !a.startsWith("-"));
    if (!pkgArg) throw new AppError(400, "No package name found in args", "VALIDATION_ERROR");
    if (!PKG_NAME_RE.test(pkgArg)) {
      throw new AppError(400, `Invalid package name: ${pkgArg}`, "VALIDATION_ERROR");
    }

    const basePkg = pkgArg.replace(/@[0-9].*$/, "");
    if (!ALLOWED_MCP_PACKAGES.has(basePkg)) {
      logger.warn({ pkgArg }, "MCP package not in allowlist — review before production use");
    }

    for (const arg of args) {
      if (!SAFE_ARG_RE.test(arg)) {
        throw new AppError(400, `Unsafe characters in arg: ${arg}`, "VALIDATION_ERROR");
      }
    }
  } else {
    if (!data.url) throw new AppError(400, "url is required for sse/http transport", "VALIDATION_ERROR");
    try {
      const u = new URL(data.url);
      if (!["http:", "https:"].includes(u.protocol)) throw new Error("protocol");
    } catch {
      throw new AppError(400, "url must be a valid http(s) URL", "VALIDATION_ERROR");
    }
  }

  if (data.env) {
    for (const k of Object.keys(data.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
        throw new AppError(400, `Invalid env var name: ${k}`, "VALIDATION_ERROR");
      }
    }
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────────

export async function listMcpConfigs(workspaceId: string) {
  const rows = await db
    .select({
      id:        userMcpConfigs.id,
      name:      userMcpConfigs.name,
      transport: userMcpConfigs.transport,
      command:   userMcpConfigs.command,
      args:      userMcpConfigs.args,
      url:       userMcpConfigs.url,
      enabled:   userMcpConfigs.enabled,
      _hasEnv:   userMcpConfigs.encryptedEnv,
      createdAt: userMcpConfigs.createdAt,
      updatedAt: userMcpConfigs.updatedAt,
    })
    .from(userMcpConfigs)
    .where(eq(userMcpConfigs.workspaceId, workspaceId));

  // Never expose encrypted env; surface only whether env vars are configured.
  return rows.map(({ _hasEnv, ...rest }) => ({ ...rest, hasEnv: _hasEnv != null }));
}

export async function createMcpConfig(workspaceId: string, data: McpConfigInput) {
  validateMcpInput(data);

  const encryptedEnv =
    data.env && Object.keys(data.env).length > 0 ? encrypt(JSON.stringify(data.env)) : null;

  const [row] = await db
    .insert(userMcpConfigs)
    .values({
      workspaceId,
      name:         data.name,
      transport:    data.transport,
      command:      data.command ?? null,
      args:         data.args ?? [],
      url:          data.url ?? null,
      encryptedEnv,
      enabled:      data.enabled ?? true,
    })
    .returning()
    .catch((err: { constraint?: string }) => {
      if (err?.constraint?.includes("uq_user_mcp_configs_ws_name")) {
        throw new ConflictError(`MCP config '${data.name}' already exists in this workspace`);
      }
      throw err as Error;
    });

  logger.info({ workspaceId, name: data.name }, "MCP config created");

  // Best-effort sync: don't fail the create if there is no running instance yet.
  await syncMcpConfigToContainer(workspaceId).catch((err) =>
    logger.warn({ err, workspaceId }, "MCP config sync failed after create"),
  );

  return { ...row!, hasEnv: encryptedEnv != null };
}

export async function updateMcpConfig(workspaceId: string, id: string, data: Partial<McpConfigInput>) {
  const [existing] = await db
    .select()
    .from(userMcpConfigs)
    .where(and(eq(userMcpConfigs.id, id), eq(userMcpConfigs.workspaceId, workspaceId)))
    .limit(1);
  if (!existing) throw new NotFoundError("MCP config");

  // Merge incoming partial data with current values for validation
  const merged: McpConfigInput = {
    name:      data.name      ?? existing.name,
    transport: data.transport ?? existing.transport,
    command:   data.command   !== undefined ? data.command   : existing.command,
    url:       data.url       !== undefined ? data.url       : existing.url,
    args:      data.args      ?? existing.args ?? [],
    env:       data.env,
  };
  validateMcpInput(merged);

  // Only re-encrypt env when explicitly provided; keep existing ciphertext otherwise.
  const encryptedEnv =
    data.env !== undefined
      ? data.env && Object.keys(data.env).length > 0
        ? encrypt(JSON.stringify(data.env))
        : null
      : existing.encryptedEnv;

  const [updated] = await db
    .update(userMcpConfigs)
    .set({
      name:         merged.name,
      transport:    merged.transport,
      command:      merged.command ?? null,
      args:         merged.args,
      url:          merged.url ?? null,
      encryptedEnv,
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      updatedAt:    new Date(),
    })
    .where(and(eq(userMcpConfigs.id, id), eq(userMcpConfigs.workspaceId, workspaceId)))
    .returning();

  logger.info({ workspaceId, id }, "MCP config updated");

  await syncMcpConfigToContainer(workspaceId).catch((err) =>
    logger.warn({ err, workspaceId }, "MCP config sync failed after update"),
  );

  return { ...updated!, hasEnv: encryptedEnv != null };
}

export async function deleteMcpConfig(workspaceId: string, id: string) {
  const [existing] = await db
    .select({ id: userMcpConfigs.id })
    .from(userMcpConfigs)
    .where(and(eq(userMcpConfigs.id, id), eq(userMcpConfigs.workspaceId, workspaceId)))
    .limit(1);
  if (!existing) throw new NotFoundError("MCP config");

  await db
    .delete(userMcpConfigs)
    .where(and(eq(userMcpConfigs.id, id), eq(userMcpConfigs.workspaceId, workspaceId)));

  logger.info({ workspaceId, id }, "MCP config deleted");

  await syncMcpConfigToContainer(workspaceId).catch((err) =>
    logger.warn({ err, workspaceId }, "MCP config sync failed after delete"),
  );
}

export async function getMcpHealth(workspaceId: string, id: string) {
  return checkMcpContainerHealth(workspaceId, id);
}
