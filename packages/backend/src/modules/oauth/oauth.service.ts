import { randomBytes, createHash } from "crypto";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../../db";
import { oauthState, oauthTokens } from "../../db/schema";
import { encrypt, decrypt, randomHex } from "../../shared/crypto";
import { NotFoundError, AppError } from "../../shared/errors";
import * as google from "./providers/google.provider";
import * as linkedin from "./providers/linkedin.provider";
import * as facebook from "./providers/facebook.provider";
import type { OAuthProvider } from "../../shared/types";

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── State management ──────────────────────────────────────────────────────────

export async function createOAuthState(workspaceId: string, userId: string, provider: OAuthProvider) {
  const state = randomHex(32);
  const codeVerifier = provider === "google" ? generateCodeVerifier() : undefined;
  const codeChallenge = codeVerifier ? generateCodeChallenge(codeVerifier) : undefined;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.insert(oauthState).values({
    state,
    workspaceId,
    userId,
    provider,
    codeVerifier,
    expiresAt,
  });

  return { state, codeChallenge };
}

export async function consumeOAuthState(state: string) {
  const [row] = await db
    .select()
    .from(oauthState)
    .where(and(eq(oauthState.state, state), gt(oauthState.expiresAt, new Date())))
    .limit(1);
  if (!row) throw new AppError(400, "Invalid or expired OAuth state", "INVALID_STATE");

  await db.delete(oauthState).where(eq(oauthState.state, state));
  return row;
}

// ── Authorization URL builders ────────────────────────────────────────────────

export async function getAuthorizationUrl(workspaceId: string, userId: string, provider: OAuthProvider) {
  const { state, codeChallenge } = await createOAuthState(workspaceId, userId, provider);

  switch (provider) {
    case "google":
      return await google.buildAuthUrl(state, codeChallenge!);
    case "linkedin":
      return await linkedin.buildAuthUrl(state);
    case "facebook":
      return await facebook.buildAuthUrl(state);
    default:
      throw new AppError(400, `Unknown provider: ${provider}`, "UNKNOWN_PROVIDER");
  }
}

// ── Callback handling ─────────────────────────────────────────────────────────

export async function handleCallback(
  provider: OAuthProvider,
  code: string,
  state: string,
): Promise<{ workspaceId: string; userId: string }> {
  const stateRow = await consumeOAuthState(state);

  let accessToken: string;
  let refreshToken: string | undefined;
  let expiresAt: Date | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let profile: any;

  switch (provider) {
    case "google": {
      const tokens = await google.exchangeCode(code, stateRow.codeVerifier!);
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token;
      expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;
      profile = await google.getUserInfo(accessToken);
      break;
    }
    case "linkedin": {
      const tokens = await linkedin.exchangeCode(code);
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token;
      expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;
      profile = await linkedin.getProfile(accessToken);
      break;
    }
    case "facebook": {
      const tokens = await facebook.exchangeCode(code);
      accessToken = tokens.access_token;
      expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;
      profile = await facebook.getProfile(accessToken);
      break;
    }
    default:
      throw new AppError(400, `Unknown provider: ${provider}`, "UNKNOWN_PROVIDER");
  }

  const providerAccountId = String((profile as { sub?: string; id?: string }).sub ?? (profile as { id: string }).id);

  // Upsert encrypted tokens
  await db
    .insert(oauthTokens)
    .values({
      workspaceId: stateRow.workspaceId,
      provider,
      providerAccountId,
      accessToken: encrypt(accessToken),
      refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
      expiresAt,
      rawProfile: profile,
      connectedBy: stateRow.userId,
    })
    .onConflictDoUpdate({
      target: [oauthTokens.workspaceId, oauthTokens.provider],
      set: {
        accessToken: encrypt(accessToken),
        refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
        expiresAt,
        rawProfile: profile,
        updatedAt: new Date(),
      },
    });

  return { workspaceId: stateRow.workspaceId, userId: stateRow.userId };
}

// ── Token retrieval and refresh ───────────────────────────────────────────────

export async function getDecryptedToken(workspaceId: string, provider: OAuthProvider) {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.workspaceId, workspaceId), eq(oauthTokens.provider, provider)))
    .limit(1);
  if (!row) return null;

  // Proactively refresh if within 5 minutes of expiry
  if (row.expiresAt && row.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    return refreshToken(workspaceId, provider, row);
  }

  return decrypt(row.accessToken);
}

async function refreshToken(
  workspaceId: string,
  provider: OAuthProvider,
  row: typeof oauthTokens.$inferSelect,
): Promise<string> {
  if (!row.refreshToken) throw new AppError(401, `${provider} token expired — please reconnect`, "TOKEN_EXPIRED");

  const encRefresh = row.refreshToken;
  const rawRefresh = decrypt(encRefresh);

  let newAccessToken: string;
  let newExpiresAt: Date | undefined;
  let newRefreshToken: string | undefined;

  switch (provider) {
    case "google": {
      const t = await google.refreshAccessToken(rawRefresh);
      newAccessToken = t.access_token;
      newExpiresAt = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : undefined;
      break;
    }
    case "linkedin": {
      const t = await linkedin.refreshAccessToken(rawRefresh);
      newAccessToken = t.access_token;
      newRefreshToken = t.refresh_token;
      newExpiresAt = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : undefined;
      break;
    }
    default:
      throw new AppError(401, `${provider} token expired — please reconnect`, "TOKEN_EXPIRED");
  }

  await db
    .update(oauthTokens)
    .set({
      accessToken: encrypt(newAccessToken),
      refreshToken: newRefreshToken ? encrypt(newRefreshToken) : row.refreshToken,
      expiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(oauthTokens.id, row.id));

  return newAccessToken;
}

export async function listConnections(workspaceId: string) {
  return db
    .select({
      provider: oauthTokens.provider,
      providerAccountId: oauthTokens.providerAccountId,
      expiresAt: oauthTokens.expiresAt,
      updatedAt: oauthTokens.updatedAt,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.workspaceId, workspaceId));
}

export async function disconnectProvider(workspaceId: string, provider: OAuthProvider) {
  const result = await db
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.workspaceId, workspaceId), eq(oauthTokens.provider, provider)));
  return result;
}
