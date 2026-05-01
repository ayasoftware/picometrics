import jwt from "jsonwebtoken";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../../db";
import { refreshTokens } from "../../db/schema";
import { config } from "../../config";
import { sha256, randomHex } from "../../shared/crypto";
import { UnauthorizedError } from "../../shared/errors";
import type { AuthPayload } from "../../shared/types";

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "access" }, config.JWT_ACCESS_SECRET, {
    expiresIn: config.JWT_ACCESS_TTL,
  } as jwt.SignOptions);
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "refresh" }, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_TTL,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AuthPayload {
  try {
    return jwt.verify(token, config.JWT_ACCESS_SECRET) as AuthPayload;
  } catch {
    throw new UnauthorizedError("Invalid or expired access token");
  }
}

export function verifyRefreshToken(token: string): AuthPayload {
  try {
    return jwt.verify(token, config.JWT_REFRESH_SECRET) as AuthPayload;
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }
}

/** Store a new refresh token in the DB (hashed). Returns the raw token. */
export async function createRefreshToken(
  userId: string,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<string> {
  const raw = randomHex(32);
  const hash = sha256(raw);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7d

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hash,
    expiresAt,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress as unknown as string,
  });

  return raw;
}

/** Validate a raw refresh token. Returns userId on success. */
export async function consumeRefreshToken(raw: string): Promise<string> {
  const hash = sha256(raw);
  const [token] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hash), eq(refreshTokens.revoked, false), gt(refreshTokens.expiresAt, new Date())))
    .limit(1);

  if (!token) throw new UnauthorizedError("Refresh token invalid or expired");

  // Rotate: revoke the used token
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.id, token.id));

  return token.userId;
}

/** Look up userId from a refresh token without rotating it (safe for read-only page loads). */
export async function peekRefreshToken(raw: string): Promise<string | null> {
  const hash = sha256(raw);
  const [token] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hash), eq(refreshTokens.revoked, false), gt(refreshTokens.expiresAt, new Date())))
    .limit(1);
  return token?.userId ?? null;
}

/** Revoke all refresh tokens for a user */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.userId, userId));
}
