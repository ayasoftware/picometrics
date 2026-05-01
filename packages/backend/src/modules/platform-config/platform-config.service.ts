import { eq } from "drizzle-orm";
import { db } from "../../db";
import { platformConfigs } from "../../db/schema";
import { encrypt, decrypt } from "../../shared/crypto";

const ALLOWED_KEYS = [
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "FACEBOOK_APP_ID",
  "FACEBOOK_APP_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
] as const;

export type PlatformConfigKey = (typeof ALLOWED_KEYS)[number];

export function isAllowedKey(key: string): key is PlatformConfigKey {
  return ALLOWED_KEYS.includes(key as PlatformConfigKey);
}

export { ALLOWED_KEYS };

/** Get a single config value, falling back to env if not in DB. */
export async function getPlatformConfig(key: PlatformConfigKey): Promise<string> {
  const [row] = await db.select().from(platformConfigs).where(eq(platformConfigs.key, key)).limit(1);
  if (row) return decrypt(row.encryptedValue);
  return process.env[key] ?? "";
}

/** Get all configs — returns keys with boolean "isSet" (never exposes values). */
export async function listPlatformConfigs(): Promise<{ key: string; isSet: boolean }[]> {
  const rows = await db.select({ key: platformConfigs.key }).from(platformConfigs);
  const dbKeys = new Set(rows.map((r) => r.key));

  return ALLOWED_KEYS.map((key) => ({
    key,
    isSet: dbKeys.has(key) || Boolean(process.env[key] && process.env[key] !== `your_${key.toLowerCase()}`),
  }));
}

export async function setPlatformConfig(key: PlatformConfigKey, value: string): Promise<void> {
  const encryptedValue = encrypt(value);
  await db
    .insert(platformConfigs)
    .values({ key, encryptedValue })
    .onConflictDoUpdate({ target: platformConfigs.key, set: { encryptedValue, updatedAt: new Date() } });
}

export async function deletePlatformConfig(key: PlatformConfigKey): Promise<void> {
  await db.delete(platformConfigs).where(eq(platformConfigs.key, key));
}
