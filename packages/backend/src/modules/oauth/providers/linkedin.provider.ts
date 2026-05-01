import { config } from "../../../config";
import { getPlatformConfig } from "../../platform-config/platform-config.service";

const SCOPES = ["r_ads", "rw_ads", "r_ads_reporting", "r_organization_social"].join(" ");

export async function buildAuthUrl(state: string): Promise<string> {
  const clientId = await getPlatformConfig("LINKEDIN_CLIENT_ID");
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     clientId,
    redirect_uri:  `${config.OAUTH_REDIRECT_BASE_URL}/api/oauth/callback/linkedin`,
    scope:         SCOPES,
    state,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const [clientId, clientSecret] = await Promise.all([
    getPlatformConfig("LINKEDIN_CLIENT_ID"),
    getPlatformConfig("LINKEDIN_CLIENT_SECRET"),
  ]);
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  `${config.OAUTH_REDIRECT_BASE_URL}/api/oauth/callback/linkedin`,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`LinkedIn token exchange failed: ${await res.text()}`);
  return res.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const [clientId, clientSecret] = await Promise.all([
    getPlatformConfig("LINKEDIN_CLIENT_ID"),
    getPlatformConfig("LINKEDIN_CLIENT_SECRET"),
  ]);
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`LinkedIn token refresh failed: ${await res.text()}`);
  return res.json() as Promise<TokenResponse>;
}

export async function getProfile(accessToken: string) {
  const res = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  token_type: string;
  scope?: string;
}
