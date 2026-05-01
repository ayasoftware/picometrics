import { config } from "../../../config";
import { getPlatformConfig } from "../../platform-config/platform-config.service";

const SCOPES = ["ads_management", "ads_read", "business_management", "read_insights"].join(",");
const API_VERSION = "v20.0";

export async function buildAuthUrl(state: string): Promise<string> {
  const appId = await getPlatformConfig("FACEBOOK_APP_ID");
  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  `${config.OAUTH_REDIRECT_BASE_URL}/api/oauth/callback/facebook`,
    scope:         SCOPES,
    response_type: "code",
    state,
  });
  return `https://www.facebook.com/${API_VERSION}/dialog/oauth?${params}`;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const [appId, appSecret] = await Promise.all([
    getPlatformConfig("FACEBOOK_APP_ID"),
    getPlatformConfig("FACEBOOK_APP_SECRET"),
  ]);

  // Step 1: Get short-lived token
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        client_id:     appId,
        client_secret: appSecret,
        redirect_uri:  `${config.OAUTH_REDIRECT_BASE_URL}/api/oauth/callback/facebook`,
        code,
      }),
  );
  if (!res.ok) throw new Error(`Facebook code exchange failed: ${await res.text()}`);
  const shortLived = (await res.json()) as TokenResponse;

  // Step 2: Exchange for long-lived token (~60 days)
  const longRes = await fetch(
    `https://graph.facebook.com/${API_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        grant_type:        "fb_exchange_token",
        client_id:         appId,
        client_secret:     appSecret,
        fb_exchange_token: shortLived.access_token,
      }),
  );
  if (!longRes.ok) throw new Error(`Facebook long-lived exchange failed: ${await longRes.text()}`);
  return longRes.json() as Promise<TokenResponse>;
}

export async function getProfile(accessToken: string) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/me?fields=id,name,email&access_token=${accessToken}`,
  );
  return res.json();
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}
