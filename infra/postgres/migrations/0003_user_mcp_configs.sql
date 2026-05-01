-- Per-workspace MCP server configuration with encrypted env secrets
CREATE TABLE IF NOT EXISTS user_mcp_configs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  transport     TEXT        NOT NULL DEFAULT 'stdio',
  command       TEXT,
  args          TEXT[]      NOT NULL DEFAULT '{}',
  url           TEXT,
  encrypted_env TEXT,
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_mcp_configs_workspace
  ON user_mcp_configs(workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_mcp_configs_ws_name
  ON user_mcp_configs(workspace_id, name);
