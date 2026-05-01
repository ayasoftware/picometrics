/**
 * Facebook Ads MCP Server (port 3103)
 * Uses Meta Graph API via plain fetch
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = parseInt(process.env.PORT ?? "3103", 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";
const FB_API = "https://graph.facebook.com/v20.0";

function checkSecret(req: express.Request, res: express.Response): string | null {
  if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) { res.status(403).json({ error: "Forbidden" }); return null; }
  const token = req.headers["x-workspace-token"] as string | undefined;
  if (!token) { res.status(401).json({ error: "No workspace token" }); return null; }
  return token;
}

async function fbGet(path: string, accessToken: string, params?: Record<string, string>) {
  const url = new URL(`${FB_API}${path}`);
  url.searchParams.set("access_token", accessToken);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Facebook API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fbPost(path: string, accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(`${FB_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  if (!res.ok) throw new Error(`Facebook API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const TOOL_SCHEMAS = [
  { type: "function" as const, function: { name: "fb_list_ad_accounts", description: "Lists all Facebook/Meta ad accounts accessible by the token.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function" as const, function: { name: "fb_list_campaigns", description: "Lists campaigns in a Facebook ad account.", parameters: { type: "object", properties: { accountId: { type: "string" }, statusFilter: { type: "array", items: { type: "string" } } }, required: ["accountId"] } } },
  { type: "function" as const, function: { name: "fb_create_campaign", description: "Creates a new Facebook ad campaign.", parameters: { type: "object", properties: { accountId: { type: "string" }, name: { type: "string" }, objective: { type: "string" }, status: { type: "string" }, dailyBudget: { type: "number", description: "In cents" }, lifetimeBudget: { type: "number", description: "In cents" } }, required: ["accountId", "name", "objective"] } } },
  { type: "function" as const, function: { name: "fb_get_insights", description: "Gets performance insights (impressions, clicks, spend) for a campaign, ad set, or ad.", parameters: { type: "object", properties: { objectId: { type: "string" }, objectType: { type: "string", enum: ["campaign", "adset", "ad"] }, since: { type: "string", description: "YYYY-MM-DD" }, until: { type: "string", description: "YYYY-MM-DD" }, fields: { type: "array", items: { type: "string" } }, breakdown: { type: "string" } }, required: ["objectId", "objectType", "since", "until"] } } },
  { type: "function" as const, function: { name: "fb_list_ad_sets", description: "Lists ad sets in a Facebook campaign.", parameters: { type: "object", properties: { campaignId: { type: "string" } }, required: ["campaignId"] } } },
  { type: "function" as const, function: { name: "fb_list_ads", description: "Lists ads in a Facebook ad set.", parameters: { type: "object", properties: { adSetId: { type: "string" } }, required: ["adSetId"] } } },
];

function buildMcpServer(accessToken: string): McpServer {
  const server = new McpServer({ name: "facebook-ads-mcp", version: "1.0.0" });

  server.tool("fb_list_ad_accounts", {}, async () => {
    const data = await fbGet("/me/adaccounts", accessToken, {
      fields: "id,name,currency,account_status,timezone_name",
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.tool("fb_list_campaigns", { accountId: z.string(), statusFilter: z.array(z.string()).optional() }, async ({ accountId, statusFilter }) => {
    const params: Record<string, string> = {
      fields: "id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time",
    };
    if (statusFilter?.length) params["effective_status"] = JSON.stringify(statusFilter);
    const data = await fbGet(`/act_${accountId}/campaigns`, accessToken, params);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.tool(
    "fb_create_campaign",
    {
      accountId: z.string(), name: z.string(), objective: z.string(),
      status: z.string().default("PAUSED"),
      dailyBudget: z.number().optional(), lifetimeBudget: z.number().optional(),
    },
    async ({ accountId, name, objective, status, dailyBudget, lifetimeBudget }) => {
      const body: Record<string, unknown> = { name, objective, status };
      if (dailyBudget) body.daily_budget = String(dailyBudget);
      if (lifetimeBudget) body.lifetime_budget = String(lifetimeBudget);
      const data = await fbPost(`/act_${accountId}/campaigns`, accessToken, body);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.tool(
    "fb_get_insights",
    {
      objectId: z.string(), objectType: z.enum(["campaign", "adset", "ad"]),
      since: z.string(), until: z.string(),
      fields: z.array(z.string()).default(["impressions", "clicks", "spend", "reach", "cpm", "cpc", "ctr"]),
      breakdown: z.string().optional(),
    },
    async ({ objectId, objectType, since, until, fields, breakdown }) => {
      const path = objectType === "campaign" ? `/act_${objectId}/insights`
        : objectType === "adset" ? `/${objectId}/insights`
        : `/${objectId}/insights`;
      const params: Record<string, string> = {
        time_range: JSON.stringify({ since, until }),
        fields: fields.join(","),
        level: objectType,
      };
      if (breakdown) params.breakdowns = breakdown;
      const data = await fbGet(path, accessToken, params);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.tool("fb_list_ad_sets", { campaignId: z.string() }, async ({ campaignId }) => {
    const data = await fbGet(`/${campaignId}/adsets`, accessToken, {
      fields: "id,name,status,targeting,optimization_goal,billing_event,bid_amount,daily_budget",
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.tool("fb_list_ads", { adSetId: z.string() }, async ({ adSetId }) => {
    const data = await fbGet(`/${adSetId}/ads`, accessToken, { fields: "id,name,status,creative" });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  return server;
}

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, service: "mcp-facebook-ads" }));
app.get("/tool-schemas", (req, res) => {
  if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) { res.status(403).json({ error: "Forbidden" }); return; }
  res.json(TOOL_SCHEMAS);
});
app.post("/mcp", async (req, res) => {
  const accessToken = checkSecret(req, res);
  if (!accessToken) return;
  const server = buildMcpServer(accessToken);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(PORT, () => console.log(`Facebook Ads MCP server listening on port ${PORT}`));
