import { Router } from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { requireAuth } from "../../middleware/auth";
import { getLaunchUrl, resolveInjection } from "./launch.service";
import { config } from "../../config";
import type { AuthenticatedRequest } from "../../shared/types";
import { readFileSync } from "fs";
import { join } from "path";

const FAVICON = readFileSync(join(__dirname, "favicon.ico"));

export const launchRouter = Router();

launchRouter.get("/favicon.ico", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "image/x-icon");
  res.setHeader("Cache-Control", "public, max-age=604800");
  res.send(FAVICON);
});

// POST /api/launch — authenticated: returns launchUrl for the user's OpenClaw instance
launchRouter.post(
  "/api/launch",
  requireAuth as unknown as RequestHandler,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await getLaunchUrl(req.userId));
    } catch (err) {
      next(err);
    }
  },
);

// GET /auth/user-settings — accessible from per-user ports via Caddy /auth/* rule; redirects to the settings page on the main domain.
launchRouter.get("/auth/user-settings", (req: Request, res: Response) => {
  let suffix = "";
  const ret = req.query.return;
  if (typeof ret === "string" && ret) {
    try {
      const u = new URL(ret);
      if (u.hostname === config.PROVISIONING_BASE_DOMAIN) {
        suffix = "?returnUrl=" + encodeURIComponent(ret);
      }
    } catch {}
  }
  res.redirect(`https://${config.PROVISIONING_BASE_DOMAIN}/user-settings${suffix}`);
});

// GET /auth/inject-sw.js — service worker served from the per-user port via Caddy /auth/* rule.
// It intercepts HTML navigations and injects a floating Settings button into the OpenClaw UI.
launchRouter.get("/auth/inject-sw.js", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // Allow registration with scope '/' even though the file lives under /auth/
  res.setHeader("Service-Worker-Allowed", "/");
  res.send(INJECT_SW);
});

// GET /auth/launch?t=TOKEN — served on each instance subdomain via Caddy split-routing.
// Registers the settings service worker, then injects the gateway token and redirects to chat.
launchRouter.get("/auth/launch", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { t } = req.query;
    if (typeof t !== "string") {
      res.status(400).send("Missing token");
      return;
    }

    const { plainToken, gwUrl } = await resolveInjection(t);

    // OpenClaw's rD() function reads #token= from the URL hash, persists it to the
    // correct localStorage key via its own eD() handler, then strips the hash.
    const chatUrl = `/chat?session=main#token=${encodeURIComponent(plainToken)}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Launching…</title>
  <style>
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;
         height:100vh;margin:0;font-family:sans-serif;background:#0f172a;color:#94a3b8;gap:16px}
    .spinner{width:32px;height:32px;border:3px solid #334155;border-top-color:#3b82f6;
             border-radius:50%;animation:spin 0.8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>Launching your workspace…</p>
  <script>
    var _chat = ${JSON.stringify(chatUrl)};
    function _go() { window.location.replace(_chat); }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/auth/inject-sw.js', { scope: '/' })
        .then(function(reg) {
          // Wait up to 2 s for the SW to activate so it controls the next navigation.
          var sw = reg.installing || reg.waiting;
          if (!sw || reg.active) { _go(); return; }
          var t = setTimeout(_go, 2000);
          sw.addEventListener('statechange', function() {
            if (sw.state === 'activated') { clearTimeout(t); _go(); }
          });
        })
        .catch(_go);
    } else {
      _go();
    }
  </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Floating Settings button injected by the service worker into every OpenClaw HTML page.
// Strips Content-Security-Policy from the proxied response so the inline script runs freely.
const INJECT_SW = `/* v2 */
'use strict';
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;

  event.respondWith(
    fetch(req).then(function(res) {
      return res.text().then(function(html) {
        var btn =
          '<script id="pcm-settings-btn">(function(){' +
            'if(document.getElementById("pcm-cfg"))return;' +
            'var a=document.createElement("a");' +
            'a.id="pcm-cfg";' +
            'var _base=location.protocol+"//"+location.hostname;' +
            'a.href=_base+"/user-settings?returnUrl="+encodeURIComponent(location.origin+"/chat?session=main");' +
            'a.style="position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
              'background:#3b82f6;color:#fff;padding:10px 18px;border-radius:8px;' +
              'font:600 13px/1 system-ui,sans-serif;text-decoration:none;' +
              'box-shadow:0 4px 14px rgba(0,0,0,.45);letter-spacing:.01em";' +
            'a.textContent="\\u2699\\uFE0F Settings";' +
            'function add(){document.body.appendChild(a);}' +
            'document.body?add():document.addEventListener("DOMContentLoaded",add);' +
          '})();<\\/script>';

        var modified = html.replace(/<\\/body>/i, btn + '</body>');
        if (modified === html) modified = html + btn;

        // Rebuild headers, dropping CSP so the injected inline script is not blocked.
        var headers = new Headers();
        res.headers.forEach(function(val, key) {
          if (!/^content-security-policy$/i.test(key)) headers.append(key, val);
        });

        return new Response(modified, { status: res.status, statusText: res.statusText, headers: headers });
      });
    })
  );
});`;

// GET / — marketing landing page for openclaw.picometrics.io
launchRouter.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https://www.picometrics.io; connect-src 'self'",
  );
  res.send(LANDING_PAGE);
});

// GET /login — the public signup/login portal served at openclaw.picometrics.io
launchRouter.get("/login", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https://www.picometrics.io; connect-src 'self'",
  );
  res.send(LOGIN_PAGE);
});

const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Picometrics — MCP Automation</title>
  <link rel="icon" href="/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --red: #e8191a;
      --red-light: #fef2f2;
      --dark: #111111;
      --mid: #555555;
      --light: #999999;
      --border: #e8e8e8;
      --bg: #ffffff;
    }

    body {
      font-family: 'Manrope', sans-serif;
      background: var(--bg);
      color: var(--dark);
      line-height: 1.6;
    }

    a { text-decoration: none; color: inherit; }

    /* NAV */
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 64px;
      border-bottom: 1px solid var(--border);
    }

    .nav-links {
      display: flex;
      gap: 36px;
      list-style: none;
    }

    .nav-links a {
      font-size: 14px;
      font-weight: 500;
      color: var(--mid);
      transition: color 0.15s;
    }

    .nav-links a:hover { color: var(--dark); }

    .btn {
      display: inline-block;
      padding: 10px 22px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Manrope', sans-serif;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.15s;
    }

    .btn:hover { opacity: 0.85; transform: translateY(-1px); }
    .btn-red { background: var(--red); color: #fff; }
    .btn-outline { border: 1.5px solid var(--border); color: var(--dark); }
    .btn-outline:hover { border-color: #bbb; }

    /* HERO */
    .hero {
      max-width: 860px;
      margin: 0 auto;
      padding: 96px 32px 80px;
      text-align: center;
    }

    .tag {
      display: inline-block;
      background: var(--red-light);
      color: var(--red);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      padding: 5px 14px;
      border-radius: 100px;
      margin-bottom: 28px;
    }

    h1 {
      font-size: clamp(36px, 5vw, 58px);
      font-weight: 800;
      line-height: 1.1;
      letter-spacing: -1.5px;
      margin-bottom: 20px;
    }

    h1 span { color: var(--red); }

    .hero p {
      font-size: 18px;
      color: var(--mid);
      max-width: 560px;
      margin: 0 auto 40px;
      line-height: 1.7;
    }

    .actions {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }

    /* DIVIDER */
    .divider {
      height: 1px;
      background: var(--border);
      max-width: 1100px;
      margin: 0 auto;
    }

    /* PLATFORMS */
    .platforms {
      padding: 64px;
      max-width: 1100px;
      margin: 0 auto;
    }

    .section-label {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--light);
      margin-bottom: 32px;
      text-align: center;
    }

    .platforms-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
    }

    .platform-card {
      border: 1.5px solid var(--border);
      border-radius: 12px;
      padding: 24px 20px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .platform-card:hover {
      border-color: var(--red);
      box-shadow: 0 4px 16px rgba(232,25,26,0.07);
    }

    .platform-icon { font-size: 26px; margin-bottom: 12px; display: block; }
    .platform-name { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
    .platform-desc { font-size: 13px; color: var(--mid); line-height: 1.55; }

    /* FEATURES */
    .features {
      padding: 80px 64px;
      max-width: 1100px;
      margin: 0 auto;
    }

    .section-header { margin-bottom: 40px; }

    .section-header h2 {
      font-size: clamp(26px, 3vw, 36px);
      font-weight: 800;
      letter-spacing: -1px;
      line-height: 1.15;
      margin-bottom: 10px;
    }

    .section-header p {
      font-size: 15px;
      color: var(--mid);
      max-width: 480px;
    }

    .features-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }

    .feature {
      padding: 24px;
      background: #fafafa;
      border-radius: 12px;
      border: 1.5px solid var(--border);
    }

    .feature-dot {
      width: 8px; height: 8px;
      background: var(--red);
      border-radius: 50%;
      margin-bottom: 14px;
    }

    .feature h3 { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
    .feature p { font-size: 13px; color: var(--mid); line-height: 1.6; }

    /* STEPS */
    .steps-section {
      background: #fafafa;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 80px 64px;
    }

    .steps-inner { max-width: 1100px; margin: 0 auto; }

    .steps-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 48px;
      margin-top: 40px;
    }

    .step-num { font-size: 12px; font-weight: 700; color: var(--red); margin-bottom: 12px; }
    .step h3 { font-size: 16px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.2px; }
    .step p { font-size: 13px; color: var(--mid); line-height: 1.65; }

    /* CTA */
    .cta {
      padding: 96px 32px;
      text-align: center;
      max-width: 640px;
      margin: 0 auto;
    }

    .cta h2 {
      font-size: clamp(26px, 3.5vw, 40px);
      font-weight: 800;
      letter-spacing: -1px;
      line-height: 1.12;
      margin-bottom: 14px;
    }

    .cta p { font-size: 15px; color: var(--mid); margin-bottom: 32px; }

    /* FOOTER */
    footer {
      border-top: 1px solid var(--border);
      padding: 24px 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .footer-copy { font-size: 13px; color: var(--light); }

    .footer-links { display: flex; gap: 24px; list-style: none; }
    .footer-links a { font-size: 13px; color: var(--light); transition: color 0.15s; }
    .footer-links a:hover { color: var(--dark); }

    /* RESPONSIVE */
    @media (max-width: 768px) {
      nav { padding: 16px 24px; }
      .nav-links { display: none; }
      .hero { padding: 64px 24px 48px; }
      .platforms { padding: 40px 24px; }
      .platforms-grid { grid-template-columns: 1fr 1fr; }
      .features { padding: 48px 24px; }
      .features-grid { grid-template-columns: 1fr; }
      .steps-section { padding: 48px 24px; }
      .steps-grid { grid-template-columns: 1fr; gap: 28px; }
      .cta { padding: 64px 24px; }
      footer { padding: 20px 24px; flex-direction: column; gap: 12px; text-align: center; }
    }
  </style>
</head>
<body>

  <!-- NAV -->
  <nav>
    <a href="https://www.picometrics.io/">
      <img src="https://www.picometrics.io/picometrics_logo.png" alt="Picometrics" style="height:28px;display:block;" />
    </a>
    <ul class="nav-links">
      <li><a href="https://www.picometrics.io/pricing">Pricing</a></li>
      <li><a href="https://www.picometrics.io/google-looker-studio-connectors">Connectors</a></li>
      <li><a href="https://www.picometrics.io/services">Services</a></li>
      <li><a href="https://www.picometrics.io/contact">Contact</a></li>
      <li><a href="/login">Sign In</a></li>
    </ul>
    <a href="/login" class="btn btn-red">Get Started</a>
  </nav>

  <!-- HERO -->
  <section class="hero">
    <div class="tag">MCP Automation</div>
    <h1>Connect OpenClaw to<br/><span>every ad platform</span></h1>
    <p>Automate Facebook Ads, Google Ads, GTM &amp; GA4 through powerful MCP integrations — no manual exports, no data silos.</p>
    <div class="actions">
      <a href="https://www.picometrics.io/contact" class="btn btn-red">Book a Call</a>
      <a href="https://www.picometrics.io/services" class="btn btn-outline">Learn More</a>
    </div>
  </section>

  <div class="divider"></div>

  <!-- PLATFORMS -->
  <div class="platforms">
    <p class="section-label">Supported Platforms</p>
    <div class="platforms-grid">
      <div class="platform-card">
        <span class="platform-icon">📘</span>
        <div class="platform-name">Facebook Ads</div>
        <p class="platform-desc">Push audiences, events, and conversion data directly into Meta.</p>
      </div>
      <div class="platform-card">
        <span class="platform-icon">🔵</span>
        <div class="platform-name">Google Ads</div>
        <p class="platform-desc">Sync conversion actions and audience lists in real time.</p>
      </div>
      <div class="platform-card">
        <span class="platform-icon">🏷️</span>
        <div class="platform-name">Google Tag Manager</div>
        <p class="platform-desc">Automate tag deployments without touching code.</p>
      </div>
      <div class="platform-card">
        <span class="platform-icon">📊</span>
        <div class="platform-name">Google Analytics 4</div>
        <p class="platform-desc">Route events and user properties with custom parameter mapping.</p>
      </div>
    </div>
  </div>

  <div class="divider"></div>

  <!-- FEATURES -->
  <div class="features">
    <div class="section-header">
      <h2>Everything you need to<br/>automate your ad stack</h2>
      <p>Built for performance marketers who want reliable data flows without the engineering overhead.</p>
    </div>
    <div class="features-grid">
      <div class="feature">
        <div class="feature-dot"></div>
        <h3>Real-Time Sync</h3>
        <p>Data flows from OpenClaw to your platforms within seconds — stay on top of performance as it happens.</p>
      </div>
      <div class="feature">
        <div class="feature-dot"></div>
        <h3>Unified MCP Layer</h3>
        <p>One protocol handles authentication, routing, and transformation across every connected platform.</p>
      </div>
      <div class="feature">
        <div class="feature-dot"></div>
        <h3>Custom Field Mapping</h3>
        <p>Define how your OpenClaw fields map to ad platform parameters — no code required.</p>
      </div>
      <div class="feature">
        <div class="feature-dot"></div>
        <h3>Secure Connections</h3>
        <p>OAuth-backed connections and encrypted transit keep your credentials and data protected.</p>
      </div>
      <div class="feature">
        <div class="feature-dot"></div>
        <h3>Bidirectional Flow</h3>
        <p>Pull performance metrics back into OpenClaw for reporting, or push updates outward — both ways.</p>
      </div>
      <div class="feature">
        <div class="feature-dot"></div>
        <h3>Built on Picometrics</h3>
        <p>Backed by the same infrastructure powering beautiful marketing dashboards worldwide.</p>
      </div>
    </div>
  </div>

  <!-- STEPS -->
  <div class="steps-section">
    <div class="steps-inner">
      <div class="section-header">
        <h2>Three steps to go live</h2>
        <p>From zero to fully automated in days, not months.</p>
      </div>
      <div class="steps-grid">
        <div class="step">
          <div class="step-num">01</div>
          <h3>Connect OpenClaw</h3>
          <p>Authenticate your account and select the data streams you want to automate — audiences, events, conversions.</p>
        </div>
        <div class="step">
          <div class="step-num">02</div>
          <h3>Configure Platforms</h3>
          <p>Link Facebook Ads, Google Ads, GTM, and GA4. Map fields, set transformation rules, and define sync frequency.</p>
        </div>
        <div class="step">
          <div class="step-num">03</div>
          <h3>Launch &amp; Monitor</h3>
          <p>Activate the MCP pipeline and monitor sync health from a single dashboard.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- CTA -->
  <div class="cta">
    <h2>Ready to automate your entire ad stack?</h2>
    <p>Talk to the Picometrics team and get your MCP pipeline live in days.</p>
    <div class="actions">
      <a href="https://www.picometrics.io/contact" class="btn btn-red">Book a Call</a>
      <a href="https://www.picometrics.io/pricing" class="btn btn-outline">View Pricing</a>
    </div>
  </div>

  <!-- FOOTER -->
  <footer>
    <span class="footer-copy">© 2026 Picometrics.io. All rights reserved.</span>
    <ul class="footer-links">
      <li><a href="https://www.picometrics.io/terms-and-conditions">Terms</a></li>
      <li><a href="https://www.picometrics.io/privacy-policy">Privacy</a></li>
      <li><a href="https://www.picometrics.io/contact">Contact</a></li>
    </ul>
  </footer>

</body>
</html>`;

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign In — OpenClaw by Picometrics</title>
  <link rel="icon" href="/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --red: #e8191a;
      --red-hover: #c91516;
      --red-light: #fef2f2;
      --dark: #111111;
      --mid: #555555;
      --light: #999999;
      --border: #e8e8e8;
      --bg: #ffffff;
      --bg-subtle: #fafafa;
    }

    body {
      font-family: 'Manrope', sans-serif;
      background: var(--bg);
      color: var(--dark);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    a { text-decoration: none; color: inherit; }

    /* NAV */
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 64px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .nav-links {
      display: flex;
      gap: 36px;
      list-style: none;
    }

    .nav-links a {
      font-size: 14px;
      font-weight: 500;
      color: var(--mid);
      transition: color 0.15s;
    }

    .nav-links a:hover { color: var(--dark); }

    .btn-nav {
      display: inline-block;
      padding: 10px 22px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Manrope', sans-serif;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.15s;
      border: 1.5px solid var(--border);
      color: var(--mid);
      background: transparent;
    }

    .btn-nav:hover {
      border-color: #bbb;
      color: var(--dark);
      transform: translateY(-1px);
    }

    /* MAIN */
    .main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      background: var(--bg-subtle);
    }

    /* CARD */
    .card {
      background: var(--bg);
      border: 1.5px solid var(--border);
      border-radius: 16px;
      padding: 40px 40px 36px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06);
    }

    .card-header {
      text-align: center;
      margin-bottom: 32px;
    }

    .card-header h1 {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: var(--dark);
      margin-bottom: 4px;
    }

    .card-header p {
      font-size: 13px;
      color: var(--light);
    }

    /* TABS */
    .tabs {
      display: flex;
      gap: 0;
      border: 1.5px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 28px;
    }

    .tab {
      flex: 1;
      padding: 9px 0;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      font-family: 'Manrope', sans-serif;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--light);
      transition: all 0.15s;
    }

    .tab:first-child { border-right: 1.5px solid var(--border); }
    .tab.active { background: var(--red-light); color: var(--red); }
    .tab:hover:not(.active) { color: var(--mid); background: var(--bg-subtle); }

    /* FORMS */
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .field { margin-bottom: 16px; }

    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--mid);
      margin-bottom: 6px;
      letter-spacing: 0.2px;
    }

    input {
      width: 100%;
      padding: 10px 14px;
      font-size: 14px;
      font-family: 'Manrope', sans-serif;
      background: var(--bg);
      border: 1.5px solid var(--border);
      border-radius: 8px;
      color: var(--dark);
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    input::placeholder { color: #c0c0c0; }
    input:focus { border-color: var(--red); box-shadow: 0 0 0 3px rgba(232,25,26,0.08); }

    .btn-submit {
      width: 100%;
      padding: 11px;
      font-size: 14px;
      font-weight: 700;
      font-family: 'Manrope', sans-serif;
      background: var(--red);
      color: #fff;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 8px;
      transition: background 0.15s, transform 0.1s;
      letter-spacing: 0.1px;
    }

    .btn-submit:hover:not(:disabled) { background: var(--red-hover); transform: translateY(-1px); }
    .btn-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

    .error {
      color: var(--red);
      font-size: 13px;
      margin-top: 14px;
      text-align: center;
      min-height: 18px;
      font-weight: 500;
    }

    .card-footer {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 12px;
      color: var(--light);
    }

    .card-footer a { color: var(--mid); font-weight: 600; }
    .card-footer a:hover { color: var(--dark); }

    /* PAGE FOOTER */
    footer {
      border-top: 1px solid var(--border);
      padding: 20px 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .footer-copy { font-size: 13px; color: var(--light); }

    .footer-links { display: flex; gap: 24px; list-style: none; }
    .footer-links a { font-size: 13px; color: var(--light); transition: color 0.15s; }
    .footer-links a:hover { color: var(--dark); }

    /* RESPONSIVE */
    @media (max-width: 768px) {
      nav { padding: 16px 24px; }
      .nav-links { display: none; }
      .main { padding: 32px 16px; align-items: flex-start; padding-top: 40px; }
      .card { padding: 32px 24px 28px; }
      footer { padding: 20px 24px; flex-direction: column; gap: 12px; text-align: center; }
    }
  </style>
</head>
<body>

  <!-- NAV -->
  <nav>
    <a href="/">
      <img src="https://www.picometrics.io/picometrics_logo.png" alt="Picometrics" style="height:28px;display:block;" />
    </a>
    <ul class="nav-links">
      <li><a href="https://www.picometrics.io/pricing">Pricing</a></li>
      <li><a href="https://www.picometrics.io/google-looker-studio-connectors">Connectors</a></li>
      <li><a href="https://www.picometrics.io/services">Services</a></li>
      <li><a href="https://www.picometrics.io/contact">Contact</a></li>
    </ul>
    <a href="/" class="btn-nav">&#8592; Back to home</a>
  </nav>

  <!-- MAIN -->
  <main class="main">
    <div class="card">

      <div class="card-header">
        <h1>Welcome to OpenClaw</h1>
        <p>Sign in to your workspace or create a new account</p>
      </div>

      <div class="tabs">
        <button class="tab active" id="tab-login" onclick="switchTab('login')">Sign in</button>
        <button class="tab" id="tab-signup" onclick="switchTab('signup')">Sign up</button>
      </div>

      <div id="form-login" class="tab-content active">
        <div class="field">
          <label for="l-email">Email</label>
          <input id="l-email" type="email" autocomplete="email" placeholder="you@example.com" />
        </div>
        <div class="field">
          <label for="l-pass">Password</label>
          <input id="l-pass" type="password" autocomplete="current-password" placeholder="••••••••" />
        </div>
        <button class="btn-submit" id="btn-login" onclick="submit('login')">Sign in</button>
      </div>

      <div id="form-signup" class="tab-content">
        <div class="field">
          <label for="s-name">Full name</label>
          <input id="s-name" type="text" autocomplete="name" placeholder="Jane Doe" />
        </div>
        <div class="field">
          <label for="s-email">Email</label>
          <input id="s-email" type="email" autocomplete="email" placeholder="you@example.com" />
        </div>
        <div class="field">
          <label for="s-pass">Password</label>
          <input id="s-pass" type="password" autocomplete="new-password" placeholder="Min 8 characters" />
        </div>
        <button class="btn-submit" id="btn-signup" onclick="submit('signup')">Create account</button>
      </div>

      <div class="error" id="err"></div>

      <div class="card-footer">
        Need access? <a href="https://www.picometrics.io/contact">Contact us</a>
      </div>

    </div>
  </main>

  <!-- FOOTER -->
  <footer>
    <span class="footer-copy">© 2026 Picometrics.io. All rights reserved.</span>
    <ul class="footer-links">
      <li><a href="https://www.picometrics.io/terms-and-conditions">Terms</a></li>
      <li><a href="https://www.picometrics.io/privacy-policy">Privacy</a></li>
      <li><a href="https://www.picometrics.io/contact">Contact</a></li>
    </ul>
  </footer>

  <script>
    function switchTab(tab) {
      ['login', 'signup'].forEach(function(t) {
        document.getElementById('form-' + t).classList.toggle('active', t === tab);
        document.getElementById('tab-' + t).classList.toggle('active', t === tab);
      });
      document.getElementById('err').textContent = '';
    }

    async function submit(mode) {
      var err = document.getElementById('err');
      err.textContent = '';
      var btn = document.getElementById('btn-' + mode);
      btn.disabled = true;
      btn.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';

      try {
        var body = mode === 'login'
          ? { email: document.getElementById('l-email').value.trim(),
              password: document.getElementById('l-pass').value }
          : { email: document.getElementById('s-email').value.trim(),
              password: document.getElementById('s-pass').value,
              fullName: document.getElementById('s-name').value.trim() };

        var authRes = await fetch('/api/auth/' + (mode === 'login' ? 'login' : 'register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        var authData = await authRes.json();
        if (!authRes.ok) {
          err.textContent = (authData.error && authData.error.message) || 'Authentication failed';
          btn.disabled = false;
          btn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
          return;
        }

        btn.textContent = 'Starting workspace…';
        var launchRes = await fetch('/api/launch', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authData.accessToken },
          credentials: 'include',
        });
        var launchData = await launchRes.json();
        if (!launchRes.ok) {
          err.textContent = (launchData.error && launchData.error.message) || 'Failed to start workspace';
          btn.disabled = false;
          btn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
          return;
        }

        btn.textContent = 'Launching…';
        window.location.href = launchData.launchUrl;
      } catch (e) {
        err.textContent = 'Network error — please try again.';
        btn.disabled = false;
        btn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      }
    }

    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      var active = document.querySelector('.tab-content.active');
      if (active) active.querySelector('.btn-submit').click();
    });
  </script>
</body>
</html>`;
