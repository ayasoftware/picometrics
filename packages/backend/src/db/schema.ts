import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  inet,
  unique,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// ── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:           uuid("id").primaryKey().defaultRandom(),
  email:        text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  fullName:     text("full_name").notNull(),
  avatarUrl:    text("avatar_url"),
  isActive:     boolean("is_active").notNull().default(true),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Refresh Tokens ────────────────────────────────────────────────────────────

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id:        uuid("id").primaryKey().defaultRandom(),
    userId:    uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked:   boolean("revoked").notNull().default(false),
    userAgent: text("user_agent"),
    ipAddress: inet("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userIdx: index("idx_refresh_tokens_user_id").on(t.userId) }),
);

// ── Workspaces ────────────────────────────────────────────────────────────────

export const workspaces = pgTable(
  "workspaces",
  {
    id:        uuid("id").primaryKey().defaultRandom(),
    name:      text("name").notNull(),
    slug:      text("slug").notNull().unique(),
    plan:      text("plan").notNull().default("free"),
    ownerId:   uuid("owner_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ ownerIdx: index("idx_workspaces_owner").on(t.ownerId) }),
);

// ── Workspace Members ─────────────────────────────────────────────────────────

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId:      uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role:        text("role").notNull().default("member"),
    invitedBy:   uuid("invited_by").references(() => users.id),
    joinedAt:    timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.workspaceId, t.userId] }),
    userIdx: index("idx_workspace_members_user").on(t.userId),
  }),
);

// ── API Keys ──────────────────────────────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy:   uuid("created_by").notNull().references(() => users.id),
    name:        text("name").notNull(),
    keyPrefix:   text("key_prefix").notNull(),
    keyHash:     text("key_hash").notNull().unique(),
    scopes:      text("scopes").array().notNull().default([]),
    lastUsedAt:  timestamp("last_used_at", { withTimezone: true }),
    expiresAt:   timestamp("expires_at", { withTimezone: true }),
    revoked:     boolean("revoked").notNull().default(false),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsIdx:   index("idx_api_keys_workspace").on(t.workspaceId),
    hashIdx: index("idx_api_keys_hash").on(t.keyHash),
  }),
);

// ── OAuth Tokens ──────────────────────────────────────────────────────────────

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    workspaceId:       uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    provider:          text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    scopes:            text("scopes").array().notNull().default([]),
    accessToken:       text("access_token").notNull(),   // AES-256-GCM encrypted
    refreshToken:      text("refresh_token"),            // AES-256-GCM encrypted
    tokenType:         text("token_type").notNull().default("Bearer"),
    expiresAt:         timestamp("expires_at", { withTimezone: true }),
    rawProfile:        jsonb("raw_profile"),
    connectedBy:       uuid("connected_by").notNull().references(() => users.id),
    createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsIdx:       index("idx_oauth_tokens_workspace").on(t.workspaceId),
    uniqueToken: unique("uq_oauth_tokens_ws_provider").on(t.workspaceId, t.provider),
  }),
);

// ── OAuth State (CSRF) ────────────────────────────────────────────────────────

export const oauthState = pgTable("oauth_state", {
  state:        text("state").primaryKey(),
  workspaceId:  uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId:       uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider:     text("provider").notNull(),
  codeVerifier: text("code_verifier"),
  expiresAt:    timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── User LLM Configs ─────────────────────────────────────────────────────────
// One row per (user, provider) so a user can have keys for OpenAI, Anthropic, and Google simultaneously.

export const userLlmConfigs = pgTable(
  "user_llm_configs",
  {
    userId:          uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider:        text("provider").notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    model:           text("model").notNull(),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.provider] }),
  }),
);

// ── Chat Sessions ─────────────────────────────────────────────────────────────

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId:      uuid("user_id").references(() => users.id),
    title:       text("title"),
    model:       text("model").notNull(),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsIdx: index("idx_chat_sessions_workspace").on(t.workspaceId) }),
);

// ── Chat Messages ─────────────────────────────────────────────────────────────

export const chatMessages = pgTable(
  "chat_messages",
  {
    id:               uuid("id").primaryKey().defaultRandom(),
    sessionId:        uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    role:             text("role").notNull(),
    content:          text("content"),
    toolCalls:        jsonb("tool_calls"),
    toolCallId:       text("tool_call_id"),
    toolName:         text("tool_name"),
    finishReason:     text("finish_reason"),
    promptTokens:     integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ sessionIdx: index("idx_chat_messages_session").on(t.sessionId) }),
);

// ── Audit Log ─────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    workspaceId:  uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    actorId:      uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action:       text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId:   text("resource_id"),
    metadata:     jsonb("metadata"),
    ipAddress:    inet("ip_address"),
    createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsIdx:        index("idx_audit_log_workspace").on(t.workspaceId),
    createdAtIdx: index("idx_audit_log_created_at").on(t.createdAt),
  }),
);

// ── User MCP Selections ───────────────────────────────────────────────────────

export const userMcpSelections = pgTable(
  "user_mcp_selections",
  {
    userId:      uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    mcpServerId: text("mcp_server_id").notNull(),
    enabled:     boolean("enabled").notNull().default(true),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.userId, t.mcpServerId] }),
    userIdx: index("idx_user_mcp_selections_user").on(t.userId),
  }),
);

// ── User MCP Configs (per-workspace stdio/sse/http MCP server definitions) ────

export const userMcpConfigs = pgTable(
  "user_mcp_configs",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    workspaceId:  uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name:         text("name").notNull(),           // key in mcp.servers map; lowercase-alphanumeric+hyphens
    transport:    text("transport").notNull().default("stdio"), // stdio | sse | http
    command:      text("command"),                  // e.g. "npx"  (stdio only)
    args:         text("args").array().notNull().default([]),   // e.g. ["-y", "@pkg/name"]
    url:          text("url"),                      // MCP endpoint URL (sse/http only)
    encryptedEnv: text("encrypted_env"),            // AES-256-GCM JSON of { KEY: "value" }
    enabled:      boolean("enabled").notNull().default(true),
    createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsIdx:      index("idx_user_mcp_configs_workspace").on(t.workspaceId),
    uniqueName: unique("uq_user_mcp_configs_ws_name").on(t.workspaceId, t.name),
  }),
);

// ── Platform Config (admin-managed OAuth app credentials etc.) ────────────────

export const platformConfigs = pgTable("platform_configs", {
  key:            text("key").primaryKey(),
  encryptedValue: text("encrypted_value").notNull(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── User Instances (per-workspace Open WebUI containers) ──────────────────────

export const userInstances = pgTable(
  "user_instances",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    workspaceId:    uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }).unique(),
    containerId:    text("container_id"),
    containerName:  text("container_name").notNull(),
    port:           integer("port").notNull().unique(),
    status:       text("status").notNull().default("provisioning"), // provisioning | running | stopped | terminated
    gatewayToken: text("gateway_token").notNull(),                   // AES-256-GCM encrypted OPENCLAW_GATEWAY_TOKEN
    createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsIdx: index("idx_user_instances_workspace").on(t.workspaceId) }),
);

// ── Type exports ──────────────────────────────────────────────────────────────

export type User             = typeof users.$inferSelect;
export type NewUser          = typeof users.$inferInsert;
export type RefreshToken     = typeof refreshTokens.$inferSelect;
export type Workspace        = typeof workspaces.$inferSelect;
export type NewWorkspace     = typeof workspaces.$inferInsert;
export type WorkspaceMember  = typeof workspaceMembers.$inferSelect;
export type ApiKey           = typeof apiKeys.$inferSelect;
export type OAuthToken       = typeof oauthTokens.$inferSelect;
export type NewOAuthToken    = typeof oauthTokens.$inferInsert;
export type UserLlmConfig      = typeof userLlmConfigs.$inferSelect;
export type UserMcpSelection   = typeof userMcpSelections.$inferSelect;
export type UserMcpConfig      = typeof userMcpConfigs.$inferSelect;
export type NewUserMcpConfig   = typeof userMcpConfigs.$inferInsert;
export type ChatSession        = typeof chatSessions.$inferSelect;
export type ChatMessage        = typeof chatMessages.$inferSelect;
export type UserInstance       = typeof userInstances.$inferSelect;
export type NewUserInstance    = typeof userInstances.$inferInsert;
