import { Router } from "express";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { workspaces, workspaceMembers, userInstances } from "../../db/schema";
import { signAccessToken, peekRefreshToken } from "../auth/token.service";
import { config } from "../../config";

export const settingsRouter = Router();

settingsRouter.get("/user-settings", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  );

  // Validate and accept the returnUrl only when it's on our domain.
  let chatUrl = "/";
  const rawReturn = req.query.returnUrl;
  if (typeof rawReturn === "string" && rawReturn) {
    try {
      const u = new URL(rawReturn);
      if (u.hostname === config.PROVISIONING_BASE_DOMAIN) {
        chatUrl = rawReturn;
      }
    } catch {}
  }

  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    res.send(buildHtml("", "", chatUrl));
    return;
  }

  try {
    const userId = await peekRefreshToken(refreshToken);
    if (!userId) {
      res.send(buildHtml("", "", chatUrl));
      return;
    }

    const [ws] = await db
      .select({ id: workspaces.id })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);

    if (ws?.id && chatUrl === "/") {
      const [instance] = await db
        .select({ port: userInstances.port })
        .from(userInstances)
        .where(eq(userInstances.workspaceId, ws.id))
        .limit(1);
      if (instance?.port) {
        chatUrl = `https://${config.PROVISIONING_BASE_DOMAIN}:${instance.port}/chat?session=main`;
      }
    }

    const backendToken = signAccessToken(userId);
    res.send(buildHtml(backendToken, ws?.id ?? "", chatUrl));
  } catch {
    res.send(buildHtml("", "", chatUrl));
  }
});

function buildHtml(token: string, workspaceId: string, chatUrl: string): string {
  const safeToken = token.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\u003c");
  const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9-]/g, "");
  const safeChatUrl = chatUrl.startsWith("https://") || chatUrl === "/" ? chatUrl : "/";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API Settings</title>
<script>
  /* Run before first paint — no theme flash. Open WebUI stores 'theme' = 'dark'|'light'|'system' in localStorage. */
  (function(){
    var t = localStorage.getItem('theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.add(dark ? 'dark' : 'light');
  })();
<\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Dark theme (default) ── */
  html.dark {
    --bg: #0f172a; --surface: #1e293b; --border: #334155;
    --text: #f1f5f9; --muted: #94a3b8; --accent: #6366f1;
    --accent-hover: #818cf8; --success: #22c55e; --error: #ef4444;
    --input-bg: #0f172a;
    color-scheme: dark;
  }

  /* ── Light theme ── */
  html.light {
    --bg: #f8fafc; --surface: #ffffff; --border: #e2e8f0;
    --text: #0f172a; --muted: #64748b; --accent: #6366f1;
    --accent-hover: #4f46e5; --success: #16a34a; --error: #dc2626;
    --input-bg: #ffffff;
    color-scheme: light;
  }

  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; min-height: 100vh; padding: 2rem 1rem; }
  .container { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: .25rem; }
  .subtitle { color: var(--muted); font-size: .875rem; margin-bottom: 2rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: .75rem; padding: 1.5rem; margin-bottom: 1.25rem; }
  .card-header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1.25rem; }
  .provider-icon { width: 2rem; height: 2rem; border-radius: .5rem; display: flex; align-items: center; justify-content: center; font-size: 1rem; font-weight: 700; flex-shrink: 0; }
  .openai-icon   { background: #10a37f22; color: #10a37f; }
  .anthropic-icon { background: #d4783022; color: #d47830; }
  .google-icon   { background: #4285f422; color: #4285f4; }
  .card-title { font-size: 1rem; font-weight: 600; }
  .card-status { margin-left: auto; font-size: .75rem; padding: .2rem .6rem; border-radius: 9999px; }
  .status-configured     { background: #22c55e22; color: var(--success); }
  .status-not-configured { background: #94a3b822; color: var(--muted); }
  label { display: block; font-size: .8125rem; font-weight: 500; color: var(--muted); margin-bottom: .375rem; }
  input, select { width: 100%; background: var(--input-bg); border: 1px solid var(--border); border-radius: .5rem; color: var(--text); font-size: .875rem; padding: .625rem .75rem; outline: none; transition: border-color .15s; }
  input:focus, select:focus { border-color: var(--accent); }
  input::placeholder { color: var(--border); }
  .field { margin-bottom: 1rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.25rem; }
  button { border: none; border-radius: .5rem; cursor: pointer; font-size: .875rem; font-weight: 500; padding: .625rem 1.25rem; transition: background .15s, opacity .15s; }
  .btn-save   { background: var(--accent); color: #fff; }
  .btn-save:hover { background: var(--accent-hover); }
  .btn-delete { background: transparent; border: 1px solid var(--border); color: var(--muted); }
  .btn-delete:hover { border-color: var(--error); color: var(--error); }
  .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: .875rem 1.25rem; border-radius: .625rem; font-size: .875rem; font-weight: 500; opacity: 0; transform: translateY(.5rem); transition: all .2s; pointer-events: none; z-index: 999; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast-success { background: var(--success); color: #fff; }
  .toast-error   { background: var(--error); color: #fff; }
  .auth-error { background: #ef444422; border: 1px solid #ef444444; border-radius: .75rem; padding: 1.25rem; margin-bottom: 1.5rem; color: #fca5a5; font-size: .875rem; }
  html.light .auth-error { background: #fee2e2; border-color: #fca5a5; color: #991b1b; }
  .mcp-list { display: flex; flex-direction: column; gap: .625rem; }
  .mcp-item { display: flex; align-items: center; justify-content: space-between; padding: .75rem 1rem; background: var(--bg); border: 1px solid var(--border); border-radius: .5rem; }
  .mcp-name { font-size: .875rem; font-weight: 500; }
  .toggle { position: relative; width: 2.5rem; height: 1.25rem; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-track { position: absolute; inset: 0; border-radius: 9999px; background: var(--border); cursor: pointer; transition: background .15s; }
  .toggle input:checked + .toggle-track { background: var(--accent); }
  .toggle-thumb { position: absolute; top: .125rem; left: .125rem; width: 1rem; height: 1rem; border-radius: 50%; background: #fff; transition: transform .15s; pointer-events: none; }
  .toggle input:checked ~ .toggle-thumb { transform: translateX(1.25rem); }
  .section-title { font-size: .875rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 1rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .back-link { display: inline-flex; align-items: center; gap: .375rem; margin-bottom: 1.5rem; font-size: .875rem; color: var(--muted); }
  .oauth-item { display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem; background: var(--bg); border: 1px solid var(--border); border-radius: .5rem; margin-bottom: .625rem; }
  .oauth-icon { width: 1.75rem; height: 1.75rem; border-radius: .375rem; display: flex; align-items: center; justify-content: center; font-size: .875rem; font-weight: 700; flex-shrink: 0; }
  .oauth-info { flex: 1; min-width: 0; }
  .oauth-name { font-size: .875rem; font-weight: 500; }
  .oauth-sub  { font-size: .75rem; color: var(--muted); margin-top: .125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn-connect    { background: var(--accent); color: #fff; padding: .4rem 1rem; font-size: .8125rem; }
  .btn-connect:hover { background: var(--accent-hover); }
  .btn-disconnect { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: .4rem 1rem; font-size: .8125rem; }
  .btn-disconnect:hover { border-color: var(--error); color: var(--error); }
</style>
</head>
<body>
<div class="container">
  <a href="${safeChatUrl}" class="back-link">← Back to Chat</a>
  <h1>API Settings</h1>
  <p class="subtitle">Configure your LLM provider keys. The key for a provider is used only when you select one of its models in the chat.</p>

  ${token ? "" : `<div class="auth-error">
    Session not found. Please <a href="/">sign in</a> first, then return to this page.
  </div>`}

  <div id="content" ${token ? "" : 'style="display:none"'}>

    <!-- OpenAI -->
    <div class="card">
      <div class="card-header">
        <div class="provider-icon openai-icon">O</div>
        <div><div class="card-title">OpenAI</div></div>
        <span class="card-status status-not-configured" id="status-openai">Not configured</span>
      </div>
      <div class="row">
        <div class="field">
          <label>API Key</label>
          <input type="password" id="key-openai" placeholder="sk-…" autocomplete="off">
        </div>
        <div class="field">
          <label>Default Model</label>
          <select id="model-openai">
            <option value="gpt-4o">GPT-4o</option>
            <option value="gpt-4o-mini">GPT-4o mini</option>
            <option value="gpt-4-turbo">GPT-4 Turbo</option>
          </select>
        </div>
      </div>
      <div class="actions">
        <button class="btn-save" onclick="saveProvider('openai')">Save</button>
        <button class="btn-delete" onclick="deleteProvider('openai')">Remove</button>
      </div>
    </div>

    <!-- Anthropic -->
    <div class="card">
      <div class="card-header">
        <div class="provider-icon anthropic-icon">A</div>
        <div><div class="card-title">Anthropic</div></div>
        <span class="card-status status-not-configured" id="status-anthropic">Not configured</span>
      </div>
      <div class="row">
        <div class="field">
          <label>API Key</label>
          <input type="password" id="key-anthropic" placeholder="sk-ant-…" autocomplete="off">
        </div>
        <div class="field">
          <label>Default Model</label>
          <select id="model-anthropic">
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-opus-4-7">Claude Opus 4.7</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
          </select>
        </div>
      </div>
      <div class="actions">
        <button class="btn-save" onclick="saveProvider('anthropic')">Save</button>
        <button class="btn-delete" onclick="deleteProvider('anthropic')">Remove</button>
      </div>
    </div>

    <!-- Google -->
    <div class="card">
      <div class="card-header">
        <div class="provider-icon google-icon">G</div>
        <div><div class="card-title">Google Gemini</div></div>
        <span class="card-status status-not-configured" id="status-google">Not configured</span>
      </div>
      <div class="row">
        <div class="field">
          <label>API Key</label>
          <input type="password" id="key-google" placeholder="AIza…" autocomplete="off">
        </div>
        <div class="field">
          <label>Default Model</label>
          <select id="model-google">
            <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
            <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
            <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
          </select>
        </div>
      </div>
      <div class="actions">
        <button class="btn-save" onclick="saveProvider('google')">Save</button>
        <button class="btn-delete" onclick="deleteProvider('google')">Remove</button>
      </div>
    </div>

    <!-- MCP Tools -->
    <div class="card">
      <div class="section-title">AI Tools (MCP Servers)</div>
      <div class="mcp-list" id="mcpList">
        <div style="color:var(--muted);font-size:.875rem">Loading…</div>
      </div>
      <div class="actions" style="margin-top:1.25rem">
        <button class="btn-save" onclick="saveMcp()">Save Tool Preferences</button>
      </div>
    </div>

    <!-- Connected Accounts -->
    <div class="card">
      <div class="section-title">Connected Accounts</div>
      <p style="color:var(--muted);font-size:.8125rem;margin-bottom:1rem">Connect your ad &amp; analytics accounts so AI tools can read and manage them on your behalf.</p>
      <div class="mcp-list" id="oauthList">
        <div style="color:var(--muted);font-size:.875rem">Loading…</div>
      </div>
    </div>

  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const authToken = "${safeToken}";
const workspaceId = "${safeWorkspaceId}";

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast toast-' + (type || 'success') + ' show';
  setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'Request failed (' + res.status + ')');
  }
  return res.json();
}

function setStatus(provider, configured, model) {
  const el = document.getElementById('status-' + provider);
  if (!el) return;
  if (configured) {
    el.textContent = model || 'Configured';
    el.className = 'card-status status-configured';
  } else {
    el.textContent = 'Not configured';
    el.className = 'card-status status-not-configured';
  }
}

async function loadConfigs() {
  try {
    const data = await api('GET', '/api/users/me/llm-config');
    for (const cfg of (data.configs || [])) {
      setStatus(cfg.provider, true, cfg.model);
      const sel = document.getElementById('model-' + cfg.provider);
      if (sel) { sel.value = cfg.model; }
    }
  } catch (e) { showToast('Failed to load configs: ' + e.message, 'error'); }
}

async function loadMcp() {
  try {
    const data = await api('GET', '/api/users/me/mcp-selections');
    const list = document.getElementById('mcpList');
    list.innerHTML = data.map(s => \`
      <div class="mcp-item">
        <span class="mcp-name">\${s.name}</span>
        <label class="toggle">
          <input type="checkbox" \${s.enabled ? 'checked' : ''} data-id="\${s.id}">
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </div>\`).join('');
  } catch (e) {
    document.getElementById('mcpList').innerHTML = '<div style="color:var(--muted);font-size:.875rem">Failed to load tools</div>';
  }
}

async function saveProvider(provider) {
  const key = document.getElementById('key-' + provider).value.trim();
  const model = document.getElementById('model-' + provider).value;
  if (!key) { showToast('Enter an API key', 'error'); return; }
  try {
    await api('PUT', '/api/users/me/llm-config', { provider, apiKey: key, model });
    setStatus(provider, true, model);
    document.getElementById('key-' + provider).value = '';
    showToast(provider[0].toUpperCase() + provider.slice(1) + ' key saved');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteProvider(provider) {
  try {
    await api('DELETE', '/api/users/me/llm-config?provider=' + provider);
    setStatus(provider, false);
    showToast(provider[0].toUpperCase() + provider.slice(1) + ' key removed');
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveMcp() {
  const checkboxes = document.querySelectorAll('#mcpList input[type=checkbox]');
  const selections = Array.from(checkboxes).map(cb => ({ id: cb.dataset.id, enabled: cb.checked }));
  try {
    await api('PUT', '/api/users/me/mcp-selections', { selections });
    showToast('Tool preferences saved');
  } catch (e) { showToast(e.message, 'error'); }
}

const OAUTH_PROVIDERS = [
  { id: 'google',   name: 'Google',   sub: 'GTM · Google Ads · Analytics', icon: 'G', cls: 'google-icon' },
  { id: 'linkedin', name: 'LinkedIn', sub: 'LinkedIn Ads',                  icon: 'in', cls: '' },
  { id: 'facebook', name: 'Facebook', sub: 'Facebook / Meta Ads',           icon: 'f', cls: '' },
];

async function loadOAuth() {
  const list = document.getElementById('oauthList');
  if (!workspaceId) { list.innerHTML = '<div style="color:var(--muted);font-size:.875rem">No workspace found.</div>'; return; }
  try {
    const connections = await api('GET', '/api/workspaces/' + workspaceId + '/oauth/connections');
    const connectedIds = new Set(connections.map(c => c.provider));
    list.innerHTML = OAUTH_PROVIDERS.map(p => {
      const connected = connectedIds.has(p.id);
      const conn = connections.find(c => c.provider === p.id);
      const sub = connected ? (conn.providerAccountId || 'Connected') : p.sub;
      return \`<div class="oauth-item">
        <div class="oauth-icon provider-icon \${p.cls || 'anthropic-icon'}" style="\${p.id==='google'?'background:#4285f422;color:#4285f4':p.id==='linkedin'?'background:#0a66c222;color:#0a66c2':'background:#1877f222;color:#1877f2'}">\${p.icon}</div>
        <div class="oauth-info">
          <div class="oauth-name">\${p.name}</div>
          <div class="oauth-sub">\${sub}</div>
        </div>
        \${connected
          ? \`<button class="btn-disconnect" onclick="oauthDisconnect('\${p.id}')">Disconnect</button>\`
          : \`<button class="btn-connect" onclick="oauthConnect('\${p.id}')">Connect</button>\`
        }
      </div>\`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div style="color:var(--muted);font-size:.875rem">Failed to load connections.</div>';
  }
}

async function oauthConnect(provider) {
  try {
    const data = await api('GET', '/api/workspaces/' + workspaceId + '/oauth/' + provider + '/authorize');
    window.location.href = data.url;
  } catch (e) { showToast(e.message, 'error'); }
}

async function oauthDisconnect(provider) {
  try {
    await api('DELETE', '/api/workspaces/' + workspaceId + '/oauth/' + provider);
    showToast(provider[0].toUpperCase() + provider.slice(1) + ' disconnected');
    loadOAuth();
  } catch (e) { showToast(e.message, 'error'); }
}

// Show success/error flash if redirected back from OAuth
const params = new URLSearchParams(location.search);
if (params.get('oauth_success')) showToast(params.get('oauth_success') + ' connected successfully!');
if (params.get('oauth_error'))   showToast('OAuth error: ' + params.get('oauth_error'), 'error');

if (authToken) {
  Promise.all([loadConfigs(), loadMcp(), loadOAuth()]);
}
</script>
</body>
</html>`;
}
