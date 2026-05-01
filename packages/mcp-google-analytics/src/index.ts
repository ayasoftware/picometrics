/**
 * Google Analytics 4 MCP Server (port 3104)
 * Uses @google-analytics/data (GA4 Data API)
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

const PORT = parseInt(process.env.PORT ?? "3104", 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

function checkSecret(req: express.Request, res: express.Response): string | null {
  if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) { res.status(403).json({ error: "Forbidden" }); return null; }
  const token = req.headers["x-workspace-token"] as string | undefined;
  if (!token) { res.status(401).json({ error: "No workspace token" }); return null; }
  return token;
}

function makeGA4Client(accessToken: string): BetaAnalyticsDataClient {
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: accessToken });
  return new BetaAnalyticsDataClient({ authClient } as never);
}

function makeAdminAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.analyticsadmin({ version: "v1beta", auth });
}

const TOOL_SCHEMAS = [
  { type: "function" as const, function: { name: "ga4_list_properties", description: "Lists GA4 properties accessible by the connected token. Pass accountId (numeric GA account ID, e.g. '123456') to filter by account, or omit to list all.", parameters: { type: "object", properties: { accountId: { type: "string", description: "Optional numeric GA account ID (not GTM account ID). Omit to list all properties." } }, required: [] } } },
  { type: "function" as const, function: { name: "ga4_run_report", description: "Runs a flexible GA4 report with custom dimensions and metrics.", parameters: { type: "object", properties: { propertyId: { type: "string" }, dateRangeStart: { type: "string", description: "YYYY-MM-DD" }, dateRangeEnd: { type: "string", description: "YYYY-MM-DD" }, dimensions: { type: "array", items: { type: "string" }, description: "e.g. sessionSource, country, deviceCategory" }, metrics: { type: "array", items: { type: "string" }, description: "e.g. sessions, users, bounceRate, conversions" }, limit: { type: "number" } }, required: ["propertyId", "dateRangeStart", "dateRangeEnd", "dimensions", "metrics"] } } },
  { type: "function" as const, function: { name: "ga4_get_traffic_summary", description: "Gets sessions by source/medium for a date range — a common marketing preset.", parameters: { type: "object", properties: { propertyId: { type: "string" }, dateRangeStart: { type: "string" }, dateRangeEnd: { type: "string" } }, required: ["propertyId", "dateRangeStart", "dateRangeEnd"] } } },
  { type: "function" as const, function: { name: "ga4_get_conversion_summary", description: "Gets conversion events and rates for a date range.", parameters: { type: "object", properties: { propertyId: { type: "string" }, dateRangeStart: { type: "string" }, dateRangeEnd: { type: "string" } }, required: ["propertyId", "dateRangeStart", "dateRangeEnd"] } } },
  { type: "function" as const, function: { name: "ga4_run_realtime_report", description: "Gets realtime GA4 data (active users in the last 30 minutes).", parameters: { type: "object", properties: { propertyId: { type: "string" }, dimensions: { type: "array", items: { type: "string" } }, metrics: { type: "array", items: { type: "string" } } }, required: ["propertyId", "dimensions", "metrics"] } } },
  { type: "function" as const, function: { name: "ga4_get_audience_overview", description: "Gets user demographics and geo breakdown for a date range.", parameters: { type: "object", properties: { propertyId: { type: "string" }, dateRangeStart: { type: "string" }, dateRangeEnd: { type: "string" } }, required: ["propertyId", "dateRangeStart", "dateRangeEnd"] } } },
  { type: "function" as const, function: { name: "ga4_get_measurement_id", description: "Returns the GA4 Measurement ID (G-XXXXXXXXXX) for a property. Use this before creating a GTM GA4 tag so the measurement ID is never hard-coded.", parameters: { type: "object", properties: { propertyId: { type: "string", description: "Numeric GA4 property ID, e.g. '534626320'" } }, required: ["propertyId"] } } },
  { type: "function" as const, function: { name: "ga4_list_data_streams", description: "Lists all data streams (web, iOS, Android) for a GA4 property, including stream name, type, and measurement ID.", parameters: { type: "object", properties: { propertyId: { type: "string", description: "Numeric GA4 property ID, e.g. '534626320'" } }, required: ["propertyId"] } } },
];

function rowsToObjects(response: { rows?: unknown[]; dimensionHeaders?: { name?: string }[]; metricHeaders?: { name?: string }[] }) {
  const dimHeaders = (response.dimensionHeaders ?? []).map((h) => h.name ?? "");
  const metHeaders = (response.metricHeaders ?? []).map((h) => h.name ?? "");
  return (response.rows ?? []).map((row: unknown) => {
    const r = row as { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] };
    const obj: Record<string, string> = {};
    (r.dimensionValues ?? []).forEach((v, i) => { obj[dimHeaders[i]!] = v.value ?? ""; });
    (r.metricValues ?? []).forEach((v, i) => { obj[metHeaders[i]!] = v.value ?? ""; });
    return obj;
  });
}

function buildMcpServer(accessToken: string): McpServer {
  const server = new McpServer({ name: "google-analytics-mcp", version: "1.0.0" });
  const ga4 = makeGA4Client(accessToken);
  const admin = makeAdminAuth(accessToken);

  server.tool("ga4_list_properties", { accountId: z.string().optional() }, async ({ accountId }) => {
    const filter = accountId ? "parent:accounts/" + accountId : "parent:accounts/-";
    const res = await admin.properties.list({ filter });
    return { content: [{ type: "text", text: JSON.stringify(res.data.properties ?? []) }] };
  });

  // @ts-ignore TS2589: complex zod schema causes deep type instantiation
  server.tool(
    "ga4_run_report",
    {
      propertyId: z.string(), dateRangeStart: z.string(), dateRangeEnd: z.string(),
      dimensions: z.array(z.string()), metrics: z.array(z.string()),
      limit: z.number().optional(),
    },
    async ({ propertyId, dateRangeStart, dateRangeEnd, dimensions, metrics, limit }) => {
      const [response] = await ga4.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: dateRangeStart, endDate: dateRangeEnd }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        limit: limit ?? 1000,
      });
      return { content: [{ type: "text", text: JSON.stringify(rowsToObjects(response as Parameters<typeof rowsToObjects>[0])) }] };
    },
  );

  server.tool(
    "ga4_get_traffic_summary",
    { propertyId: z.string(), dateRangeStart: z.string(), dateRangeEnd: z.string() },
    async ({ propertyId, dateRangeStart, dateRangeEnd }) => {
      const [response] = await ga4.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: dateRangeStart, endDate: dateRangeEnd }],
        dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "bounceRate" }, { name: "conversions" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 50,
      });
      return { content: [{ type: "text", text: JSON.stringify(rowsToObjects(response as Parameters<typeof rowsToObjects>[0])) }] };
    },
  );

  server.tool(
    "ga4_get_conversion_summary",
    { propertyId: z.string(), dateRangeStart: z.string(), dateRangeEnd: z.string() },
    async ({ propertyId, dateRangeStart, dateRangeEnd }) => {
      const [response] = await ga4.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: dateRangeStart, endDate: dateRangeEnd }],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "sessions" }, { name: "conversions" }, { name: "sessionConversionRate" }],
        dimensionFilter: { filter: { fieldName: "isConversionEvent", stringFilter: { value: "true" } } },
        limit: 50,
      });
      return { content: [{ type: "text", text: JSON.stringify(rowsToObjects(response as Parameters<typeof rowsToObjects>[0])) }] };
    },
  );

  server.tool(
    "ga4_run_realtime_report",
    { propertyId: z.string(), dimensions: z.array(z.string()), metrics: z.array(z.string()) },
    async ({ propertyId, dimensions, metrics }) => {
      const [response] = await ga4.runRealtimeReport({
        property: `properties/${propertyId}`,
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
      });
      return { content: [{ type: "text", text: JSON.stringify(rowsToObjects(response as Parameters<typeof rowsToObjects>[0])) }] };
    },
  );

  server.tool(
    "ga4_get_audience_overview",
    { propertyId: z.string(), dateRangeStart: z.string(), dateRangeEnd: z.string() },
    async ({ propertyId, dateRangeStart, dateRangeEnd }) => {
      const dateRanges = [{ startDate: dateRangeStart, endDate: dateRangeEnd }];
      const prop = `properties/${propertyId}`;

      const [geo] = await ga4.runReport({ property: prop, dateRanges, dimensions: [{ name: "country" }], metrics: [{ name: "totalUsers" }], orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }], limit: 20 });
      const [device] = await ga4.runReport({ property: prop, dateRanges, dimensions: [{ name: "deviceCategory" }], metrics: [{ name: "sessions" }] });
      const [newVsRet] = await ga4.runReport({ property: prop, dateRanges, dimensions: [{ name: "newVsReturning" }], metrics: [{ name: "totalUsers" }] });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            countries: rowsToObjects(geo as Parameters<typeof rowsToObjects>[0]),
            devices: rowsToObjects(device as Parameters<typeof rowsToObjects>[0]),
            newVsReturning: rowsToObjects(newVsRet as Parameters<typeof rowsToObjects>[0]),
          }),
        }],
      };
    },
  );

  server.tool(
    "ga4_get_measurement_id",
    { propertyId: z.string() },
    async ({ propertyId }) => {
      const res = await admin.properties.dataStreams.list({ parent: `properties/${propertyId}` });
      const streams = res.data.dataStreams ?? [];
      const ids = streams
        .map((s: { webStreamData?: { measurementId?: string } }) => s.webStreamData?.measurementId)
        .filter(Boolean);
      return { content: [{ type: "text", text: ids.length ? ids[0]! : "No web stream found for this property" }] };
    },
  );

  server.tool(
    "ga4_list_data_streams",
    { propertyId: z.string() },
    async ({ propertyId }) => {
      const res = await admin.properties.dataStreams.list({ parent: `properties/${propertyId}` });
      const streams = (res.data.dataStreams ?? []).map((s: Record<string, unknown>) => ({
        name: s.name,
        displayName: s.displayName,
        type: s.type,
        measurementId: (s.webStreamData as Record<string, unknown> | undefined)?.measurementId,
        bundleId: (s.androidAppStreamData as Record<string, unknown> | undefined)?.bundleId
          ?? (s.iosAppStreamData as Record<string, unknown> | undefined)?.bundleId,
        createTime: s.createTime,
        updateTime: s.updateTime,
      }));
      return { content: [{ type: "text", text: JSON.stringify(streams) }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, service: "mcp-google-analytics" }));
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
app.listen(PORT, () => console.log(`Google Analytics MCP server listening on port ${PORT}`));
