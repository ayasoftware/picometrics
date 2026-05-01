CREATE TABLE IF NOT EXISTS user_instances (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  container_id     TEXT,
  container_name   TEXT NOT NULL,
  port             INTEGER NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'provisioning',
  webui_secret_key TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_instances_workspace ON user_instances(workspace_id);
