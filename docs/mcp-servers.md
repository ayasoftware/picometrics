# Configuring MCP Servers per Workspace

Each workspace can have its own set of stdio/sse/http MCP servers configured
via the REST API.  The backend writes `openclaw.json` into the user's container
volume and restarts the container whenever the configuration changes.

## API reference

| Method | Path | Auth |
|--------|------|------|
| `GET`    | `/api/workspaces/:wsId/mcp-configs`        | member  |
| `POST`   | `/api/workspaces/:wsId/mcp-configs`        | admin   |
| `PUT`    | `/api/workspaces/:wsId/mcp-configs/:id`    | admin   |
| `DELETE` | `/api/workspaces/:wsId/mcp-configs/:id`    | admin   |
| `POST`   | `/api/workspaces/:wsId/mcp-configs/sync`   | admin   |
| `GET`    | `/api/workspaces/:wsId/mcp-configs/:id/health` | member |

**Important**: `env` values are AES-256-GCM encrypted at rest.  The `GET` list
endpoint never returns decrypted values — it only surfaces `hasEnv: true/false`.

---

## Adding the Google Ads MCP server

```bash
curl -X POST https://<host>/api/workspaces/<wsId>/mcp-configs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "google-ads-direct",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-google-ads"],
    "env": {
      "GOOGLE_CLIENT_ID": "<your-client-id>",
      "GOOGLE_CLIENT_SECRET": "<your-client-secret>",
      "GOOGLE_REFRESH_TOKEN": "<your-refresh-token>",
      "GOOGLE_ADS_DEVELOPER_TOKEN": "<your-developer-token>",
      "GOOGLE_ADS_CUSTOMER_ID": "<10-digit-customer-id>"
    }
  }'
```

Required env vars:

| Variable | Where to get it |
|----------|----------------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_REFRESH_TOKEN` | OAuth flow with `https://www.googleapis.com/auth/adwords` scope |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API Center → Developer token |
| `GOOGLE_ADS_CUSTOMER_ID` | 10-digit Customer ID (no hyphens) |

---

## Adding the Facebook Ads MCP server

```bash
curl -X POST https://<host>/api/workspaces/<wsId>/mcp-configs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "facebook-ads-direct",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-facebook-ads"],
    "env": {
      "FACEBOOK_ACCESS_TOKEN": "<your-long-lived-user-token>",
      "FACEBOOK_AD_ACCOUNT_ID": "act_<account-id>"
    }
  }'
```

Required env vars:

| Variable | Where to get it |
|----------|----------------|
| `FACEBOOK_ACCESS_TOKEN` | Meta Developer Console → long-lived user access token with `ads_management` permission |
| `FACEBOOK_AD_ACCOUNT_ID` | Business Manager → Ad Accounts (format: `act_123456`) |

---

## Adding the Google Analytics 4 (GA4) MCP server

```bash
curl -X POST https://<host>/api/workspaces/<wsId>/mcp-configs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ga4-direct",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-google-analytics"],
    "env": {
      "GOOGLE_CLIENT_ID": "<your-client-id>",
      "GOOGLE_CLIENT_SECRET": "<your-client-secret>",
      "GOOGLE_REFRESH_TOKEN": "<your-refresh-token>",
      "GA4_PROPERTY_ID": "<numeric-property-id>"
    }
  }'
```

Required env vars:

| Variable | Where to get it |
|----------|----------------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_REFRESH_TOKEN` | OAuth flow with `https://www.googleapis.com/auth/analytics.readonly` scope |
| `GA4_PROPERTY_ID` | GA4 Admin → Property → Property ID (numeric, no `properties/` prefix) |

---

## Adding the Google Tag Manager (GTM) MCP server

```bash
curl -X POST https://<host>/api/workspaces/<wsId>/mcp-configs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "gtm-direct",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-gtm"],
    "env": {
      "GOOGLE_CLIENT_ID": "<your-client-id>",
      "GOOGLE_CLIENT_SECRET": "<your-client-secret>",
      "GOOGLE_REFRESH_TOKEN": "<your-refresh-token>",
      "GTM_ACCOUNT_ID": "<account-id>",
      "GTM_CONTAINER_ID": "<container-id>"
    }
  }'
```

Required env vars:

| Variable | Where to get it |
|----------|----------------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_REFRESH_TOKEN` | OAuth flow with `https://www.googleapis.com/auth/tagmanager.edit.containers` scope |
| `GTM_ACCOUNT_ID` | GTM → Admin → Account Settings → Account ID |
| `GTM_CONTAINER_ID` | GTM → Admin → Container Settings → Container ID |

---

## Disabling / re-enabling a server

```bash
# Disable
curl -X PUT https://<host>/api/workspaces/<wsId>/mcp-configs/<id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Re-enable
curl -X PUT https://<host>/api/workspaces/<wsId>/mcp-configs/<id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

The container is restarted automatically on every change.

## Manual sync

If the container was restarted outside the API (e.g. `docker restart`), force a
config re-apply without changing any DB state:

```bash
curl -X POST https://<host>/api/workspaces/<wsId>/mcp-configs/sync \
  -H "Authorization: Bearer <token>"
```

## Health check

```bash
curl https://<host>/api/workspaces/<wsId>/mcp-configs/<id>/health \
  -H "Authorization: Bearer <token>"
```

Response (stdio):

```json
{ "healthy": true, "commandPath": "/usr/local/bin/npx" }
```

## Security notes

- Credentials are encrypted with AES-256-GCM before storage. The encryption key
  (`TOKEN_ENCRYPTION_KEY`) must be 32 random bytes (64 hex chars) and must never
  be committed to source control.
- Only workspace admins and owners can create, update, or delete MCP configs.
  Members can only list configs and query health.
- OpenClaw containers run on the `openclaw_internal` Docker network.  They cannot
  reach PostgreSQL, Redis, or internal MCP servers directly.
- Port 18789 (OpenClaw gateway) is never published to the host.  All traffic
  flows through Caddy on the internal network.
- Package names are validated against a safe character regex and a logged
  allowlist.  Arbitrary shell commands are rejected.
