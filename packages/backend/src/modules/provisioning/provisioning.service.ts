import Docker from "dockerode";
import { eq, max, and } from "drizzle-orm";
import { db } from "../../db";
import { userInstances, workspaces, workspaceMembers, userLlmConfigs, userMcpConfigs } from "../../db/schema";
import { encrypt, decrypt, randomHex } from "../../shared/crypto";
import { NotFoundError, ConflictError, AppError } from "../../shared/errors";
import { config } from "../../config";
import { logger } from "../../shared/logger";
import { redis } from "../../redis";
import type { UserInstance } from "../../db/schema";

const docker = new Docker({ socketPath: config.PROVISIONING_DOCKER_SOCKET });

// Isolated network for OpenClaw containers.
// Backend and Caddy also join this network so they can reach containers by name.
// Not marked `internal: true` because OpenClaw needs internet access to run `npx` packages.
const OPENCLAW_NETWORK = config.OPENCLAW_DOCKER_NETWORK;

// ── Caddy Admin API ────────────────────────────────────────────────────────────

// Each user gets a dedicated Caddy HTTP server on their allocated port.
// Split routing: /auth/* and /mcp-proxy/* → backend, everything else → OpenClaw container.
export async function caddyAddServer(slug: string, containerName: string, port: number): Promise<void> {
  const server = {
    listen: [`:${port}`],
    // Reuse the existing cert for PROVISIONING_BASE_DOMAIN — no new ACME challenge needed.
    tls_connection_policies: [{ match: { sni: [config.PROVISIONING_BASE_DOMAIN] } }],
    routes: [
      {
        match: [{ path: ["/auth/*", "/mcp-proxy/*"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "backend:4000" }] }],
      },
      {
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${containerName}:18789` }] }],
      },
    ],
  };
  const url = `${config.CADDY_ADMIN_URL}/config/apps/http/servers/openclaw-${slug}`;
  const headers = { "Content-Type": "application/json", "Origin": config.CADDY_ADMIN_URL };

  // DELETE first to ensure idempotent upsert (Caddy returns 409 if key already exists on PUT).
  await fetch(url, { method: "DELETE", headers }).catch(() => {});

  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(server) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ slug, status: res.status, body }, "Caddy server add failed");
  }
}

async function caddyRemoveServer(slug: string): Promise<void> {
  const res = await fetch(`${config.CADDY_ADMIN_URL}/config/apps/http/servers/openclaw-${slug}`, {
    method: "DELETE",
    headers: { "Origin": config.CADDY_ADMIN_URL },
  });
  if (!res.ok) logger.warn({ slug }, "Caddy server remove failed");
}

// ── Image pull ────────────────────────────────────────────────────────────────

// Pulls a Docker image and waits for completion.  Rejects if the image is not
// found or the registry is unreachable.
async function pullImage(image: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (docker as any).pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (docker.modem as any).followProgress(stream, (err2: Error | null) => {
        if (err2) reject(err2);
        else resolve();
      });
    });
  });
}

// ── Port allocation ────────────────────────────────────────────────────────────

async function allocatePort(): Promise<number> {
  const [row] = await db.select({ maxPort: max(userInstances.port) }).from(userInstances);
  const next = (row?.maxPort ?? config.PROVISIONING_BASE_PORT - 1) + 1;
  if (next > config.PROVISIONING_BASE_PORT + 999) throw new AppError(503, "Port pool exhausted", "PORT_EXHAUSTED");
  return next;
}

// ── Instance URL ───────────────────────────────────────────────────────────────

export function instanceUrl(port: number): string {
  return `https://${config.PROVISIONING_BASE_DOMAIN}:${port}`;
}

export function instanceWsUrl(port: number): string {
  return `wss://${config.PROVISIONING_BASE_DOMAIN}:${port}`;
}

// ── MCP server config helpers ──────────────────────────────────────────────────

// Returns the mcp.servers object for openclaw.json, merging built-in HTTP proxy
// servers with any user-configured stdio/sse/http servers for the workspace.
async function buildMcpServersSection(workspaceId: string, plainToken: string): Promise<Record<string, unknown>> {
  const mcpBaseUrl = "http://backend:4000/mcp-proxy";
  const servers: Record<string, unknown> = {
    "gtm":              { url: `${mcpBaseUrl}/gtm`,              headers: { "x-gateway-token": plainToken } },
    "google-ads":       { url: `${mcpBaseUrl}/google-ads`,       headers: { "x-gateway-token": plainToken } },
    "linkedin-ads":     { url: `${mcpBaseUrl}/linkedin-ads`,     headers: { "x-gateway-token": plainToken } },
    "facebook-ads":     { url: `${mcpBaseUrl}/facebook-ads`,     headers: { "x-gateway-token": plainToken } },
    "google-analytics": { url: `${mcpBaseUrl}/google-analytics`, headers: { "x-gateway-token": plainToken } },
  };

  const userConfigs = await db
    .select()
    .from(userMcpConfigs)
    .where(and(eq(userMcpConfigs.workspaceId, workspaceId), eq(userMcpConfigs.enabled, true)));

  for (const cfg of userConfigs) {
    const entry: Record<string, unknown> = { transport: cfg.transport };
    if (cfg.command) entry.command = cfg.command;
    if (cfg.args?.length) entry.args = cfg.args;
    if (cfg.url) entry.url = cfg.url;
    if (cfg.encryptedEnv) {
      try {
        entry.env = JSON.parse(decrypt(cfg.encryptedEnv)) as Record<string, string>;
      } catch {
        logger.warn({ configId: cfg.id }, "Failed to decrypt MCP env; skipping entry");
      }
    }
    servers[cfg.name] = entry;
  }

  return servers;
}

// Rewrites openclaw.json (and auth-profiles.json) inside a running container, then
// restarts it so OpenClaw picks up the new MCP server list.  No-ops when no
// running instance exists — the config will be applied on the next provision call.
export async function syncMcpConfigToContainer(workspaceId: string): Promise<void> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw new NotFoundError("Workspace");

  const [instance] = await db
    .select()
    .from(userInstances)
    .where(and(eq(userInstances.workspaceId, workspaceId), eq(userInstances.status, "running")))
    .limit(1);

  if (!instance?.containerId) {
    logger.info({ workspaceId }, "No running instance; MCP config saved, will apply on next provision");
    return;
  }

  const plainToken = decrypt(instance.gatewayToken);
  const mcpServers = await buildMcpServersSection(workspaceId, plainToken);

  const ownerConfigs = await db
    .select({ provider: userLlmConfigs.provider, model: userLlmConfigs.model, encryptedApiKey: userLlmConfigs.encryptedApiKey })
    .from(userLlmConfigs)
    .where(eq(userLlmConfigs.userId, ws.ownerId));

  const authProfiles = buildAuthProfilesJson(ownerConfigs);

  // Build a batch array for `openclaw config set --batch-file` — the official CLI approach.
  // Direct JSON write is cleared by OpenClaw on restart; config set persists through restarts.
  const batchOps: { path: string; value: unknown }[] = Object.entries(mcpServers).map(([name, def]) => ({
    path: `mcp.servers.${name}`,
    value: def,
  }));

  // Keep the default model in sync with the DB setting
  const defaultModel = ownerConfigs[0] ? `${ownerConfigs[0].provider}/${ownerConfigs[0].model}` : null;
  if (defaultModel) {
    batchOps.push({ path: "agents.defaults.model", value: defaultModel });
  }
  const batchB64    = Buffer.from(JSON.stringify(batchOps)).toString("base64");
  const authProfilesB64 = Buffer.from(authProfiles).toString("base64");

  const container = docker.getContainer(instance.containerId);

  // Step 1: write auth-profiles + batch file
  const setupCmd = [
    `mkdir -p /home/node/.openclaw/agents/main/agent`,
    `echo '${authProfilesB64}' | base64 -d > /home/node/.openclaw/agents/main/agent/auth-profiles.json`,
    `echo '${batchB64}' | base64 -d > /tmp/mcp-batch.json`,
  ].join(" && ");

  const setupExec = await container.exec({ Cmd: ["sh", "-c", setupCmd], AttachStdout: true, AttachStderr: true });
  const setupStream = await setupExec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve) => { setupStream.on("end", resolve); setupStream.on("error", () => resolve()); });

  // Step 2: apply MCP servers via OpenClaw's own CLI so they survive gateway restarts
  const exec = await container.exec({
    Cmd: ["node", "openclaw.mjs", "config", "set", "--batch-file", "/tmp/mcp-batch.json", "--strict-json"],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  const output = await new Promise<string>((resolve) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
    stream.on("end",  () => resolve(buf));
    stream.on("error", () => resolve(buf));
  });
  const stderr = output; // docker multiplexes stdout+stderr into one stream

  const execInfo = await exec.inspect();
  if (execInfo.ExitCode !== 0) {
    logger.error({ workspaceId, stderr, exitCode: execInfo.ExitCode }, "MCP config write failed inside container");
    throw new AppError(500, "Failed to write MCP config into container", "CONTAINER_WRITE_FAILED");
  }
  if (stderr.replace(/[\x00-\x1f]/g, "").trim()) {
    logger.warn({ workspaceId, stderr }, "MCP config write produced output on stderr");
  }

  await container.restart({ t: 5 });
  logger.info({ workspaceId, servers: Object.keys(mcpServers) }, "MCP config synced; container restarted");
}

// Returns a health summary for a single user-configured MCP server.
// For stdio: checks that the launcher command exists in the container.
// For http/sse: does a HEAD request against the configured URL.
export async function checkMcpContainerHealth(workspaceId: string, configId: string) {
  const [cfg] = await db
    .select()
    .from(userMcpConfigs)
    .where(and(eq(userMcpConfigs.id, configId), eq(userMcpConfigs.workspaceId, workspaceId)))
    .limit(1);
  if (!cfg) throw new NotFoundError("MCP config");

  const [instance] = await db
    .select()
    .from(userInstances)
    .where(and(eq(userInstances.workspaceId, workspaceId), eq(userInstances.status, "running")))
    .limit(1);

  if (!instance?.containerId) {
    return { healthy: false, reason: "No running OpenClaw instance" };
  }

  if (cfg.transport === "stdio" && cfg.command) {
    try {
      const container = docker.getContainer(instance.containerId);
      const exec = await container.exec({
        Cmd: ["which", cfg.command],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const out = await new Promise<string>((resolve) => {
        let buf = "";
        stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
        stream.on("end",  () => resolve(buf));
        stream.on("error", () => resolve(""));
      });
      const info = await exec.inspect();
      if (info.ExitCode !== 0) {
        return { healthy: false, reason: `'${cfg.command}' not found in container` };
      }
      return { healthy: true, commandPath: out.replace(/[\x00-\x1f]/g, "").trim() };
    } catch (err) {
      logger.warn({ err, workspaceId, configId }, "MCP health check exec failed");
      return { healthy: false, reason: "Health check exec failed" };
    }
  }

  if ((cfg.transport === "sse" || cfg.transport === "http") && cfg.url) {
    try {
      const res = await fetch(cfg.url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      return { healthy: res.ok || res.status < 500, statusCode: res.status };
    } catch {
      return { healthy: false, reason: "URL unreachable" };
    }
  }

  return { healthy: true };
}

// ── Provision ──────────────────────────────────────────────────────────────────

function buildAuthProfilesJson(configs: { provider: string; encryptedApiKey: string }[]): string {
  const profiles: Record<string, { type: string; provider: string; key: string }> = {};
  for (const cfg of configs) {
    profiles[cfg.provider] = { type: "api_key", provider: cfg.provider, key: decrypt(cfg.encryptedApiKey) };
  }
  return JSON.stringify({ version: 1, profiles });
}

export async function syncOpenClawAuthProfiles(userId: string): Promise<void> {
  const [member] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  if (!member) return;

  const [instance] = await db
    .select()
    .from(userInstances)
    .where(and(eq(userInstances.workspaceId, member.workspaceId), eq(userInstances.status, "running")))
    .limit(1);
  if (!instance?.containerId) return;

  const llmConfigs = await db
    .select({ provider: userLlmConfigs.provider, model: userLlmConfigs.model, encryptedApiKey: userLlmConfigs.encryptedApiKey })
    .from(userLlmConfigs)
    .where(eq(userLlmConfigs.userId, userId));

  const authProfiles = buildAuthProfilesJson(llmConfigs);
  const b64 = Buffer.from(authProfiles).toString("base64");

  // Update openclaw.json default model to match the first configured provider so
  // OpenClaw doesn't try to use a provider the user hasn't added a key for.
  const defaultModel = llmConfigs.length > 0
    ? `${llmConfigs[0]!.provider}/${llmConfigs[0]!.model}`
    : null;
  const modelUpdateCmd = defaultModel
    ? `node -e "try{const fs=require('fs'),p='/home/node/.openclaw/openclaw.json',c=JSON.parse(fs.readFileSync(p,'utf8'));c.agents=c.agents||{};c.agents.defaults=c.agents.defaults||{};c.agents.defaults.model='${defaultModel}';fs.writeFileSync(p,JSON.stringify(c))}catch(e){}" &&`
    : "";

  const container = docker.getContainer(instance.containerId);
  const exec = await container.exec({
    Cmd: ["sh", "-c", `${modelUpdateCmd} echo '${b64}' | base64 -d > /home/node/.openclaw/agents/main/agent/auth-profiles.json`],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("error", () => resolve());
  });

  // Restart so OpenClaw re-reads the updated config from disk.
  await container.restart({ t: 5 });
  logger.info({ userId, defaultModel }, "OpenClaw auth-profiles synced and container restarted");
}

export async function provisionInstance(workspaceId: string): Promise<UserInstance & { url: string; plainGatewayToken: string }> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw new NotFoundError("Workspace");

  const existing = await db.select().from(userInstances).where(eq(userInstances.workspaceId, workspaceId)).limit(1);
  if (existing.length > 0 && existing[0]!.status !== "terminated") {
    throw new ConflictError("Instance already exists for this workspace");
  }

  const port = await allocatePort();
  const containerName = `openclaw-${ws.slug}`;
  const plainToken = randomHex(32);
  const gatewayToken = encrypt(plainToken);
  const origin = instanceUrl(port);

  // Re-use the existing row when re-provisioning after termination (unique constraint on workspace_id)
  const [instance] = existing.length > 0
    ? await db
        .update(userInstances)
        .set({ containerName, port, status: "provisioning", gatewayToken, containerId: null, updatedAt: new Date() })
        .where(eq(userInstances.workspaceId, workspaceId))
        .returning()
    : await db
        .insert(userInstances)
        .values({ workspaceId, containerName, port, status: "provisioning", gatewayToken })
        .returning();

  try {
    // Write openclaw.json and auth-profiles.json into the volume before container boots.
    // Volume mounts at /home/node/.openclaw in the main container, so write to /data/* directly.
    // auth-profiles.json goes at agents/main/agent/auth-profiles.json (OpenClaw's default agent path).
    const mcpServers = await buildMcpServersSection(workspaceId, plainToken);
    const ocConfig = JSON.stringify({
      gateway: {
        controlUi: {
          allowedOrigins: [origin],
          // Disables device-pairing requirement for Control UI operator connections.
          // Users authenticate via the shared gateway token; device pairing adds no security here.
          dangerouslyDisableDeviceAuth: true,
        },
        trustedProxies: ["172.0.0.0/8"],
      },
      agents: { defaults: { model: `${config.LLM_PROVIDER}/gpt-4o` } },
      mcp: { servers: mcpServers },
    });
    // Load the workspace owner's stored LLM keys; fall back to empty profiles
    const ownerConfigs = await db
      .select({ provider: userLlmConfigs.provider, encryptedApiKey: userLlmConfigs.encryptedApiKey })
      .from(userLlmConfigs)
      .where(eq(userLlmConfigs.userId, ws.ownerId));
    const authProfiles = buildAuthProfilesJson(ownerConfigs);
    // base64-encode so env values with single quotes or special chars don't break sh -c
    const ocConfigB64     = Buffer.from(ocConfig).toString("base64");
    const authProfilesB64 = Buffer.from(authProfiles).toString("base64");
    const volumeName = `openclaw_data_${ws.slug}`;
    const initScript = [
      `mkdir -p /data/agents/main/agent`,
      `echo '${ocConfigB64}' | base64 -d > /data/openclaw.json`,
      `echo '${authProfilesB64}' | base64 -d > /data/agents/main/agent/auth-profiles.json`,
      `chown -R 1000:1000 /data`,
    ].join(" && ");
    const setup = await docker.createContainer({
      Image: "alpine",
      Cmd: ["sh", "-c", initScript],
      HostConfig: { Binds: [`${volumeName}:/data`], AutoRemove: true },
    });
    await setup.start();
    await setup.wait();

    const container = await docker.createContainer({
      name: containerName,
      Image: config.PROVISIONING_OPENCLAW_IMAGE,
      Cmd: ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"],
      Env: [`OPENCLAW_GATEWAY_TOKEN=${plainToken}`, "NODE_OPTIONS=--max-old-space-size=1280"],
      HostConfig: {
        Memory: 1536 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        Binds: [`${volumeName}:/home/node/.openclaw`],
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: OPENCLAW_NETWORK, // isolated network — Caddy & backend share it; postgres/redis do not
      },
    });

    await container.start();

    // Cache plain gateway token → workspaceId for fast MCP proxy auth
    await redis.set(`gw:${plainToken}`, workspaceId);

    // Register a dedicated Caddy HTTP server on the user's allocated port
    await caddyAddServer(ws.slug, containerName, port);

    const [updated] = await db
      .update(userInstances)
      .set({ containerId: container.id, status: "running", updatedAt: new Date() })
      .where(eq(userInstances.workspaceId, workspaceId))
      .returning();

    logger.info({ workspaceId, port, slug: ws.slug }, "OpenClaw instance provisioned");

    // OpenClaw rewrites openclaw.json on first startup (clears mcp.servers from our init script).
    // Sync MCP config via config set after a delay so the gateway has finished initializing.
    setTimeout(() => {
      syncMcpConfigToContainer(workspaceId).catch((err) =>
        logger.warn({ err, workspaceId }, "Post-provision MCP sync failed"),
      );
    }, 35_000);

    return { ...updated!, url: origin, plainGatewayToken: plainToken };
  } catch (err) {
    await db
      .update(userInstances)
      .set({ status: "terminated", updatedAt: new Date() })
      .where(eq(userInstances.workspaceId, workspaceId));
    throw err;
  }
}

// ── Upgrade ────────────────────────────────────────────────────────────────────

// Replaces the running container with a new one built from `image`, preserving
// the named volume (config + state), port, gateway token, and Caddy route.
// The volume is a Docker named volume (`openclaw_data_<slug>`), so it survives
// container removal — only the container layer is swapped.
async function recreateContainer(
  instance: UserInstance,
  ws: { slug: string },
  image: string,
): Promise<string> {
  const plainToken = decrypt(instance.gatewayToken);
  const volumeName = `openclaw_data_${ws.slug}`;

  // Stop then remove the old container; errors are ignored so a partially-started
  // or already-stopped container doesn't block the upgrade.
  if (instance.containerId) {
    const old = docker.getContainer(instance.containerId);
    await old.stop({ t: 10 }).catch(() => {});
    await old.remove().catch(() => {});
  }

  const newContainer = await docker.createContainer({
    name: instance.containerName,
    Image: image,
    Cmd: ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"],
    Env: [`OPENCLAW_GATEWAY_TOKEN=${plainToken}`, "NODE_OPTIONS=--max-old-space-size=1280"],
    HostConfig: {
      Memory: 1536 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      Binds: [`${volumeName}:/home/node/.openclaw`],
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: OPENCLAW_NETWORK,
    },
  });

  await newContainer.start();
  return newContainer.id;
}

export async function upgradeInstance(
  workspaceId: string,
  image = config.PROVISIONING_OPENCLAW_IMAGE,
): Promise<UserInstance> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw new NotFoundError("Workspace");

  const [instance] = await db.select().from(userInstances).where(eq(userInstances.workspaceId, workspaceId)).limit(1);
  if (!instance) throw new NotFoundError("Instance");
  if (!["running", "stopped"].includes(instance.status)) {
    throw new AppError(409, `Cannot upgrade an instance with status '${instance.status}'`, "INVALID_STATE");
  }

  logger.info({ workspaceId, image }, "Pulling OpenClaw image for upgrade");
  await pullImage(image);

  const newContainerId = await recreateContainer(instance, ws, image);

  // Repopulate Redis gateway token → workspaceId mapping
  const plainToken = decrypt(instance.gatewayToken);
  await redis.set(`gw:${plainToken}`, workspaceId);

  // Restore Caddy route in case the restart cleared in-memory state
  await caddyAddServer(ws.slug, instance.containerName, instance.port);

  const [updated] = await db
    .update(userInstances)
    .set({ containerId: newContainerId, status: "running", updatedAt: new Date() })
    .where(eq(userInstances.workspaceId, workspaceId))
    .returning();

  logger.info({ workspaceId, image, newContainerId }, "OpenClaw instance upgraded");
  return updated!;
}

// Upgrades every running instance to `image`.  Pulls the image once before
// touching any containers so a bad image tag fails fast without partial upgrades.
export async function upgradeAllInstances(
  image = config.PROVISIONING_OPENCLAW_IMAGE,
): Promise<{ total: number; succeeded: number; failed: number; errors: string[] }> {
  logger.info({ image }, "Pulling OpenClaw image for bulk upgrade");
  await pullImage(image);

  const rows = await db
    .select({ instance: userInstances, slug: workspaces.slug })
    .from(userInstances)
    .innerJoin(workspaces, eq(userInstances.workspaceId, workspaces.id))
    .where(eq(userInstances.status, "running"));

  const results = await Promise.allSettled(
    rows.map(async ({ instance, slug }) => {
      const newContainerId = await recreateContainer(instance, { slug }, image);
      const plainToken = decrypt(instance.gatewayToken);
      await redis.set(`gw:${plainToken}`, instance.workspaceId);
      await caddyAddServer(slug, instance.containerName, instance.port);
      await db
        .update(userInstances)
        .set({ containerId: newContainerId, status: "running", updatedAt: new Date() })
        .where(eq(userInstances.workspaceId, instance.workspaceId));
      logger.info({ workspaceId: instance.workspaceId, image }, "Instance upgraded");
    }),
  );

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String(r.reason));

  return {
    total:     rows.length,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed:    errors.length,
    errors,
  };
}

// Pushes updated MCP config to every running instance in parallel.
// Safe to call at any time: merges only mcp.servers, never wipes gateway.auth.token.
export async function syncAllMcpConfigs(): Promise<{ total: number; succeeded: number; failed: number; errors: string[] }> {
  const rows = await db
    .select({ workspaceId: userInstances.workspaceId })
    .from(userInstances)
    .where(eq(userInstances.status, "running"));

  const results = await Promise.allSettled(
    rows.map(({ workspaceId }) => syncMcpConfigToContainer(workspaceId)),
  );

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String(r.reason));

  return {
    total:     rows.length,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed:    errors.length,
    errors,
  };
}

// ── Stop ───────────────────────────────────────────────────────────────────────

export async function stopInstance(workspaceId: string): Promise<UserInstance> {
  const [instance] = await db.select().from(userInstances).where(eq(userInstances.workspaceId, workspaceId)).limit(1);
  if (!instance) throw new NotFoundError("Instance");
  if (!instance.containerId) throw new AppError(409, "Container not yet started", "NOT_STARTED");

  await docker.getContainer(instance.containerId).stop({ t: 5 }).catch(() => {});

  const [updated] = await db
    .update(userInstances)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(userInstances.workspaceId, workspaceId))
    .returning();

  logger.info({ workspaceId }, "Instance stopped");
  return updated!;
}

// ── Start ──────────────────────────────────────────────────────────────────────

export async function startInstance(workspaceId: string): Promise<UserInstance> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const [instance] = await db.select().from(userInstances).where(eq(userInstances.workspaceId, workspaceId)).limit(1);
  if (!instance) throw new NotFoundError("Instance");
  if (!instance.containerId) throw new AppError(409, "Container not yet started", "NOT_STARTED");

  await docker.getContainer(instance.containerId).start();

  // Repopulate Redis cache in case it was cleared by a backend restart
  try {
    const plainToken = decrypt(instance.gatewayToken);
    await redis.set(`gw:${plainToken}`, workspaceId);
  } catch {
    // Non-fatal
  }

  if (ws) await caddyAddServer(ws.slug, instance.containerName, instance.port);

  const [updated] = await db
    .update(userInstances)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(userInstances.workspaceId, workspaceId))
    .returning();

  logger.info({ workspaceId }, "Instance started");
  return updated!;
}

// ── Destroy ────────────────────────────────────────────────────────────────────

export async function destroyInstance(workspaceId: string): Promise<void> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const [instance] = await db.select().from(userInstances).where(eq(userInstances.workspaceId, workspaceId)).limit(1);
  if (!instance) throw new NotFoundError("Instance");

  // Remove gateway token from Redis cache before instance data is wiped
  try {
    const plainToken = decrypt(instance.gatewayToken);
    await redis.del(`gw:${plainToken}`);
  } catch {
    // Non-fatal — token may not be in cache if provisioning failed mid-way
  }

  if (instance.containerId) {
    const container = docker.getContainer(instance.containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ v: true }).catch(() => {});
  }

  if (ws) await caddyRemoveServer(ws.slug);

  await db
    .update(userInstances)
    .set({ status: "terminated", containerId: null, updatedAt: new Date() })
    .where(eq(userInstances.workspaceId, workspaceId));

  logger.info({ workspaceId }, "Instance destroyed");
}

// ── User-facing instance status ────────────────────────────────────────────────

// Lightweight status for the settings page: current image vs suggested image.
// Uses docker inspect so no extra DB column is needed.
export async function getUserInstanceStatus(workspaceId: string) {
  const [instance] = await db
    .select()
    .from(userInstances)
    .where(eq(userInstances.workspaceId, workspaceId))
    .limit(1);

  if (!instance) return null;

  let currentImage: string | null = null;
  if (instance.containerId && instance.status === "running") {
    try {
      const info = await docker.getContainer(instance.containerId).inspect();
      currentImage = (info as { Config: { Image: string } }).Config.Image;
    } catch {
      // container may have been removed outside the API
    }
  }

  const suggestedImage = config.PROVISIONING_OPENCLAW_IMAGE;
  const tag = (img: string) => img.split(":").pop() ?? img;

  // Only surface an upgrade when the admin has pinned to a specific version
  // (not :latest) and it differs from what's running.
  const upgradeAvailable =
    !!currentImage &&
    currentImage !== suggestedImage &&
    !suggestedImage.endsWith(":latest");

  return {
    status:         instance.status,
    currentImage,
    currentTag:     currentImage ? tag(currentImage) : null,
    suggestedImage,
    suggestedTag:   tag(suggestedImage),
    upgradeAvailable,
  };
}

// ── Status / List ──────────────────────────────────────────────────────────────

export async function getInstanceStatus(workspaceId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const [instance] = await db.select().from(userInstances).where(eq(userInstances.workspaceId, workspaceId)).limit(1);
  if (!instance) throw new NotFoundError("Instance");

  let dockerStatus: string | null = null;
  if (instance.containerId) {
    try {
      dockerStatus = (await docker.getContainer(instance.containerId).inspect()).State.Status;
    } catch {
      dockerStatus = "missing";
    }
  }

  const { gatewayToken: _, ...safe } = instance;
  return { ...safe, dockerStatus, url: instanceUrl(instance.port) };
}

export async function listInstances() {
  const rows = await db
    .select({ instance: userInstances, slug: workspaces.slug })
    .from(userInstances)
    .innerJoin(workspaces, eq(userInstances.workspaceId, workspaces.id));

  return rows.map(({ instance: { gatewayToken: _, ...safe } }) => ({
    ...safe,
    url: instanceUrl(safe.port),
  }));
}

// ── Caddy route restoration ────────────────────────────────────────────────────
// Re-registers all running instances with Caddy after a backend or Caddy restart.
// Caddy's dynamic config is in-memory only; this call is idempotent (PUT is upsert).

export async function restoreCaddyRoutes(): Promise<void> {
  const rows = await db
    .select({ instance: userInstances, slug: workspaces.slug })
    .from(userInstances)
    .innerJoin(workspaces, eq(userInstances.workspaceId, workspaces.id))
    .where(eq(userInstances.status, "running"));

  await Promise.allSettled(
    rows.map(async ({ instance, slug }) => {
      await caddyAddServer(slug, instance.containerName, instance.port);
      // Also repopulate Redis cache in case Redis was restarted
      try {
        const plainToken = decrypt(instance.gatewayToken);
        await redis.set(`gw:${plainToken}`, instance.workspaceId);
      } catch (err) {
        logger.warn({ err, workspaceId: instance.workspaceId }, "Failed to restore gateway token in Redis — token will be re-cached on next MCP connection");
      }
    })
  );

  logger.info({ count: rows.length }, "Caddy routes restored");
}

// ── Device approval ────────────────────────────────────────────────────────────

export async function approveDevices(workspaceId: string): Promise<string[]> {
  const [instance] = await db.select().from(userInstances).where(eq(userInstances.workspaceId, workspaceId)).limit(1);
  if (!instance) throw new NotFoundError("Instance");
  if (!instance.containerId) throw new AppError(409, "Container not yet started", "NOT_STARTED");

  const container = docker.getContainer(instance.containerId);
  const exec = await container.exec({
    Cmd: ["node", "openclaw.mjs", "devices", "list", "--pending", "--json"],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  const output = await new Promise<string>((resolve, reject) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });

  let pending: { requestId: string }[] = [];
  try {
    // Docker multiplexes stdout/stderr with an 8-byte header per frame; strip non-printable prefix
    const json = output.replace(/[\x00-\x08\x0e-\x1f]/g, "").trim();
    pending = JSON.parse(json || "[]");
  } catch {
    pending = [];
  }

  const approved: string[] = [];
  for (const { requestId } of pending) {
    const approveExec = await container.exec({
      Cmd: ["node", "openclaw.mjs", "devices", "approve", requestId],
      AttachStdout: true,
      AttachStderr: true,
    });
    await approveExec.start({ hijack: true, stdin: false });
    approved.push(requestId);
  }

  logger.info({ workspaceId, approved }, "Pending devices approved");
  return approved;
}
