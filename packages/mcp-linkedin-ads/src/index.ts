/**
 * LinkedIn Ads MCP Server (port 3102)
 * Uses LinkedIn Marketing API via plain fetch (no official Node SDK)
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = parseInt(process.env.PORT ?? "3102", 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";
const LI_API = "https://api.linkedin.com/rest";
const LI_VERSION = "202408"; // LinkedIn API version header

function checkSecret(req: express.Request, res: express.Response): string | null {
  if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) { res.status(403).json({ error: "Forbidden" }); return null; }
  const token = req.headers["x-workspace-token"] as string | undefined;
  if (!token) { res.status(401).json({ error: "No workspace token" }); return null; }
  return token;
}

function liHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LI_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

async function liGet(accessToken: string, path: string, params?: Record<string, string>) {
  const url = new URL(`${LI_API}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: liHeaders(accessToken) });
  if (!res.ok) throw new Error(`LinkedIn API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const TOOL_SCHEMAS = [
  { type: "function" as const, function: { name: "li_list_ad_accounts", description: "Lists all LinkedIn ad accounts the token can access.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function" as const, function: { name: "li_list_campaigns", description: "Lists campaigns in a LinkedIn ad account.", parameters: { type: "object", properties: { accountId: { type: "string" }, statusFilter: { type: "string" } }, required: ["accountId"] } } },
  { type: "function" as const, function: { name: "li_get_analytics", description: "Gets campaign analytics (impressions, clicks, spend) for a date range.", parameters: { type: "object", properties: { accountId: { type: "string" }, campaignIds: { type: "array", items: { type: "string" } }, dateRangeStart: { type: "string", description: "YYYY-MM-DD" }, dateRangeEnd: { type: "string", description: "YYYY-MM-DD" }, timeGranularity: { type: "string", enum: ["DAILY", "MONTHLY", "ALL"] } }, required: ["accountId", "dateRangeStart", "dateRangeEnd"] } } },
  { type: "function" as const, function: { name: "li_list_creatives", description: "Lists creatives (ads) in a LinkedIn campaign.", parameters: { type: "object", properties: { accountId: { type: "string" }, campaignId: { type: "string" } }, required: ["accountId", "campaignId"] } } },
  { type: "function" as const, function: { name: "li_create_campaign", description: "Creates a new LinkedIn ad campaign.", parameters: { type: "object", properties: { accountId: { type: "string" }, name: { type: "string" }, objectiveType: { type: "string" }, type: { type: "string" }, costType: { type: "string" }, dailyBudgetAmount: { type: "number" }, dailyBudgetCurrency: { type: "string" } }, required: ["accountId", "name", "objectiveType", "type", "costType"] } } },
];

function buildMcpServer(accessToken: string): McpServer {
  const server = new McpServer({ name: "linkedin-ads-mcp", version: "1.0.0" });

  server.tool("li_list_ad_accounts", {}, async () => {
    const data = await liGet(accessToken, "/adAccounts", { q: "search" });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.tool("li_list_campaigns", { accountId: z.string(), statusFilter: z.string().optional() }, async ({ accountId, statusFilter }) => {
    const params: Record<string, string> = { q: "search", "search.account.values[0]": `urn:li:sponsoredAccount:${accountId}` };
    if (statusFilter) params["search.status.values[0]"] = statusFilter;
    const data = await liGet(accessToken, "/adCampaigns", params);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.tool(
    "li_get_analytics",
    {
      accountId: z.string(),
      campaignIds: z.array(z.string()).optional(),
      dateRangeStart: z.string(),
      dateRangeEnd: z.string(),
      timeGranularity: z.enum(["DAILY", "MONTHLY", "ALL"]).default("DAILY"),
    },
    async ({ accountId, campaignIds, dateRangeStart, dateRangeEnd, timeGranularity }) => {
      const [startYear, startMonth, startDay] = dateRangeStart.split("-").map(Number);
      const [endYear, endMonth, endDay] = dateRangeEnd.split("-").map(Number);
      const params: Record<string, string> = {
        q: "analytics",
        pivot: "CAMPAIGN",
        timeGranularity,
        "dateRange.start.year": String(startYear),
        "dateRange.start.month": String(startMonth),
        "dateRange.start.day": String(startDay),
        "dateRange.end.year": String(endYear),
        "dateRange.end.month": String(endMonth),
        "dateRange.end.day": String(endDay),
        "accounts[0]": `urn:li:sponsoredAccount:${accountId}`,
        fields: "impressions,clicks,costInLocalCurrency,externalWebsiteConversions",
      };
      if (campaignIds?.length) {
        campaignIds.forEach((id, i) => { params[`campaigns[${i}]`] = `urn:li:sponsoredCampaign:${id}`; });
      }
      const data = await liGet(accessToken, "/adAnalytics", params);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.tool("li_list_creatives", { accountId: z.string(), campaignId: z.string() }, async ({ campaignId }) => {
    const data = await liGet(accessToken, "/adCreatives", {
      q: "search",
      "search.campaign.values[0]": `urn:li:sponsoredCampaign:${campaignId}`,
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.tool(
    "li_create_campaign",
    {
      accountId: z.string(), name: z.string(), objectiveType: z.string(),
      type: z.string(), costType: z.string(),
      dailyBudgetAmount: z.number().optional(), dailyBudgetCurrency: z.string().optional(),
    },
    async ({ accountId, name, objectiveType, type, costType, dailyBudgetAmount, dailyBudgetCurrency }) => {
      const body: Record<string, unknown> = {
        account: `urn:li:sponsoredAccount:${accountId}`,
        name,
        objectiveType,
        type,
        costType,
        status: "PAUSED",
      };
      if (dailyBudgetAmount) {
        body.dailyBudget = { amount: String(dailyBudgetAmount), currencyCode: dailyBudgetCurrency ?? "USD" };
      }
      const res = await fetch(`${LI_API}/adCampaigns`, {
        method: "POST",
        headers: liHeaders(accessToken),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`LinkedIn create campaign failed: ${await res.text()}`);
      return { content: [{ type: "text", text: JSON.stringify(await res.json()) }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, service: "mcp-linkedin-ads" }));
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
app.listen(PORT, () => console.log(`LinkedIn Ads MCP server listening on port ${PORT}`));
