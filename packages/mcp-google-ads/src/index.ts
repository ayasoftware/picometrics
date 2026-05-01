/**
 * Google Ads MCP Server (port 3101)
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { GoogleAdsApi, enums } from "google-ads-api";

const PORT = parseInt(process.env.PORT ?? "3101", 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";

function checkSecret(req: express.Request, res: express.Response): string | null {
  if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  const token = req.headers["x-workspace-token"] as string | undefined;
  if (!token) {
    res.status(401).json({ error: "No workspace token" });
    return null;
  }
  return token;
}

function makeClient(accessToken: string) {
  return new GoogleAdsApi({
    client_id: "",
    client_secret: "",
    developer_token: DEVELOPER_TOKEN,
  });
}

const TOOL_SCHEMAS = [
  { type: "function" as const, function: { name: "gads_list_accessible_customers", description: "Lists all Google Ads customer accounts accessible by the token (including MCC children).", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function" as const, function: { name: "gads_list_campaigns", description: "Lists campaigns in a Google Ads customer account.", parameters: { type: "object", properties: { customerId: { type: "string" }, statusFilter: { type: "string", enum: ["ENABLED", "PAUSED", "ALL"] } }, required: ["customerId"] } } },
  { type: "function" as const, function: { name: "gads_get_campaign", description: "Gets full details of a single Google Ads campaign.", parameters: { type: "object", properties: { customerId: { type: "string" }, campaignId: { type: "string" } }, required: ["customerId", "campaignId"] } } },
  { type: "function" as const, function: { name: "gads_create_campaign", description: "Creates a new Google Ads campaign.", parameters: { type: "object", properties: { customerId: { type: "string" }, name: { type: "string" }, channelType: { type: "string" }, dailyBudgetMicros: { type: "number" }, biddingStrategy: { type: "string" }, startDate: { type: "string" }, endDate: { type: "string" } }, required: ["customerId", "name", "channelType", "dailyBudgetMicros"] } } },
  { type: "function" as const, function: { name: "gads_pause_campaign", description: "Pauses a Google Ads campaign.", parameters: { type: "object", properties: { customerId: { type: "string" }, campaignId: { type: "string" } }, required: ["customerId", "campaignId"] } } },
  { type: "function" as const, function: { name: "gads_enable_campaign", description: "Enables (un-pauses) a Google Ads campaign.", parameters: { type: "object", properties: { customerId: { type: "string" }, campaignId: { type: "string" } }, required: ["customerId", "campaignId"] } } },
  { type: "function" as const, function: { name: "gads_get_campaign_report", description: "Fetches performance metrics for campaigns (impressions, clicks, cost, conversions) for a date range.", parameters: { type: "object", properties: { customerId: { type: "string" }, dateRangeStart: { type: "string", description: "YYYY-MM-DD" }, dateRangeEnd: { type: "string", description: "YYYY-MM-DD" }, campaignIds: { type: "array", items: { type: "string" } } }, required: ["customerId", "dateRangeStart", "dateRangeEnd"] } } },
  { type: "function" as const, function: { name: "gads_list_keywords", description: "Lists keywords in a Google Ads ad group.", parameters: { type: "object", properties: { customerId: { type: "string" }, adGroupId: { type: "string" } }, required: ["customerId", "adGroupId"] } } },
];

function buildMcpServer(accessToken: string): McpServer {
  const server = new McpServer({ name: "google-ads-mcp", version: "1.0.0" });

  const client = new GoogleAdsApi({
    client_id: "",
    client_secret: "",
    developer_token: DEVELOPER_TOKEN,
  });

  const customer = (customerId: string) =>
    client.Customer({ customer_id: customerId, refresh_token: "", login_customer_id: customerId });

  server.tool("gads_list_accessible_customers", {}, async () => {
    // Uses the access token to list accessible customer IDs
    const res = await fetch("https://googleads.googleapis.com/v17/customers:listAccessibleCustomers", {
      headers: { Authorization: `Bearer ${accessToken}`, "developer-token": DEVELOPER_TOKEN },
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.tool("gads_list_campaigns", { customerId: z.string(), statusFilter: z.string().optional() }, async ({ customerId, statusFilter }) => {
    const c = customer(customerId);
    const whereClause = statusFilter && statusFilter !== "ALL"
      ? `WHERE campaign.status = '${statusFilter}'`
      : "WHERE campaign.status != 'REMOVED'";
    const campaigns = await c.query(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.start_date, campaign.end_date FROM campaign ${whereClause}`);
    return { content: [{ type: "text", text: JSON.stringify(campaigns) }] };
  });

  server.tool("gads_get_campaign", { customerId: z.string(), campaignId: z.string() }, async ({ customerId, campaignId }) => {
    const c = customer(customerId);
    const result = await c.query(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.start_date, campaign.end_date FROM campaign WHERE campaign.id = ${campaignId}`);
    return { content: [{ type: "text", text: JSON.stringify(result[0] ?? null) }] };
  });

  server.tool(
    "gads_create_campaign",
    { customerId: z.string(), name: z.string(), channelType: z.string(), dailyBudgetMicros: z.number(), biddingStrategy: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional() },
    async ({ customerId, name, channelType, dailyBudgetMicros, startDate, endDate }) => {
      // Budget must be created first, then campaign
      const c = customer(customerId);
      const budgetResult = await c.campaignBudgets.create([{ name: `${name} budget`, amount_micros: dailyBudgetMicros, delivery_method: enums.BudgetDeliveryMethod.STANDARD }]);
      const budgetResource = (budgetResult.results[0] as { resource_name: string }).resource_name;

      const campaignResult = await c.campaigns.create([{
        name,
        advertising_channel_type: channelType as never,
        campaign_budget: budgetResource,
        status: enums.CampaignStatus.PAUSED,
        start_date: startDate,
        end_date: endDate,
      }]);
      return { content: [{ type: "text", text: JSON.stringify(campaignResult) }] };
    },
  );

  server.tool("gads_pause_campaign", { customerId: z.string(), campaignId: z.string() }, async ({ customerId, campaignId }) => {
    const c = customer(customerId);
    const result = await c.campaigns.update([{ resource_name: `customers/${customerId}/campaigns/${campaignId}`, status: enums.CampaignStatus.PAUSED }]);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.tool("gads_enable_campaign", { customerId: z.string(), campaignId: z.string() }, async ({ customerId, campaignId }) => {
    const c = customer(customerId);
    const result = await c.campaigns.update([{ resource_name: `customers/${customerId}/campaigns/${campaignId}`, status: enums.CampaignStatus.ENABLED }]);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.tool(
    "gads_get_campaign_report",
    { customerId: z.string(), dateRangeStart: z.string(), dateRangeEnd: z.string(), campaignIds: z.array(z.string()).optional() },
    async ({ customerId, dateRangeStart, dateRangeEnd, campaignIds }) => {
      const c = customer(customerId);
      const campaignFilter = campaignIds?.length
        ? `AND campaign.id IN (${campaignIds.join(",")})`
        : "";
      const result = await c.query(
        `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, segments.date
         FROM campaign
         WHERE segments.date BETWEEN '${dateRangeStart}' AND '${dateRangeEnd}'
         ${campaignFilter}
         AND campaign.status != 'REMOVED'`,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool("gads_list_keywords", { customerId: z.string(), adGroupId: z.string() }, async ({ customerId, adGroupId }) => {
    const c = customer(customerId);
    const result = await c.query(
      `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status
       FROM ad_group_criterion
       WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group.id = ${adGroupId}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, service: "mcp-google-ads" }));

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

app.listen(PORT, () => console.log(`Google Ads MCP server listening on port ${PORT}`));
