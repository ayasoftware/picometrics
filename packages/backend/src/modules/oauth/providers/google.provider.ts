import { config } from "../../../config";
import { getPlatformConfig } from "../../platform-config/platform-config.service";

const SCOPES = [
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  "https://www.googleapis.com/auth/tagmanager.publish",
  "openid",
  "email",
  "profile",
].join(" ");

export async function buildAuthUrl(state: string, codeChallenge: string): Promise<string> {
  const clientId = await getPlatformConfig("GOOGLE_CLIENT_ID");
  const params = new URLSearchParams({
    client_id:              clientId,
    redirect_uri:           `${config.OAUTH_REDIRECT_BASE_URL}/api/oauth/callback/google`,
    response_type:          "code",
    scope:                  SCOPES,
    state,
    code_challenge:         codeChallenge,
    code_challenge_method:  "S256",
    access_type:            "offline",
    prompt:                 "consent",
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const [clientId, clientSecret] = await Promise.all([
    getPlatformConfig("GOOGLE_CLIENT_ID"),
    getPlatformConfig("GOOGLE_CLIENT_SECRET"),
  ]);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  `${config.OAUTH_REDIRECT_BASE_URL}/api/oauth/callback/google`,
      grant_type:    "authorization_code",
      code,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  return res.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const [clientId, clientSecret] = await Promise.all([
    getPlatformConfig("GOOGLE_CLIENT_ID"),
    getPlatformConfig("GOOGLE_CLIENT_SECRET"),
  ]);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`);
  return res.json() as Promise<TokenResponse>;
}

export async function getUserInfo(accessToken: string) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}
