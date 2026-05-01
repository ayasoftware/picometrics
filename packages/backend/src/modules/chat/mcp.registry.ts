import { config } from "../../config";
import type { OAuthProvider } from "../../shared/types";

export interface McpServerEntry {
  url: string;
  provider: OAuthProvider;
}

export interface McpServerMeta extends McpServerEntry {
  id: string;
  name: string;
}

export const MCP_REGISTRY: Record<string, McpServerEntry> = {
  gtm_:  { url: config.MCP_GTM_URL,            provider: "google" },
  gads_: { url: config.MCP_GOOGLE_ADS_URL,      provider: "google" },
  li_:   { url: config.MCP_LINKEDIN_ADS_URL,    provider: "linkedin" },
  fb_:   { url: config.MCP_FACEBOOK_ADS_URL,    provider: "facebook" },
  ga4_:  { url: config.MCP_GOOGLE_ANALYTICS_URL, provider: "google" },
};

/** Canonical list with stable IDs for user selections */
export const MCP_SERVERS: McpServerMeta[] = [
  { id: "gtm",               name: "Google Tag Manager", url: config.MCP_GTM_URL,             provider: "google" },
  { id: "google-ads",        name: "Google Ads",         url: config.MCP_GOOGLE_ADS_URL,       provider: "google" },
  { id: "linkedin-ads",      name: "LinkedIn Ads",       url: config.MCP_LINKEDIN_ADS_URL,     provider: "linkedin" },
  { id: "facebook-ads",      name: "Facebook Ads",       url: config.MCP_FACEBOOK_ADS_URL,     provider: "facebook" },
  { id: "google-analytics",  name: "Google Analytics",   url: config.MCP_GOOGLE_ANALYTICS_URL, provider: "google" },
];

export function resolveMcpServer(toolName: string): McpServerEntry | null {
  for (const [prefix, entry] of Object.entries(MCP_REGISTRY)) {
    if (toolName.startsWith(prefix)) return entry;
  }
  return null;
}

/** All unique MCP server URLs (deduplicated, for OAuth-based lookup) */
export function allMcpServers(): { url: string; provider: OAuthProvider }[] {
  const seen = new Set<string>();
  return Object.values(MCP_REGISTRY).filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });
}
