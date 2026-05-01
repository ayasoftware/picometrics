import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { userLlmConfigs } from "../../db/schema";
import { encrypt, decrypt } from "../../shared/crypto";
import { NotFoundError, AppError } from "../../shared/errors";
import type { LlmConfig } from "../chat/llm.provider";

const ALLOWED_PROVIDERS = ["openai", "anthropic", "google"] as const;
type AllowedProvider = (typeof ALLOWED_PROVIDERS)[number];

/** Return the user's stored config for a specific provider, or null if not set. */
export async function getUserLlmConfig(userId: string, provider?: string): Promise<LlmConfig | null> {
  const conditions = provider
    ? and(eq(userLlmConfigs.userId, userId), eq(userLlmConfigs.provider, provider))
    : eq(userLlmConfigs.userId, userId);

  const [row] = await db
    .select()
    .from(userLlmConfigs)
    .where(conditions)
    .limit(1);

  if (!row) return null;

  return {
    provider: row.provider as LlmConfig["provider"],
    apiKey: decrypt(row.encryptedApiKey),
    model: row.model,
  };
}

/** Return all provider configs for the user (no API keys exposed). */
export async function getAllUserLlmConfigs(userId: string): Promise<{ provider: string; model: string }[]> {
  const rows = await db
    .select({ provider: userLlmConfigs.provider, model: userLlmConfigs.model })
    .from(userLlmConfigs)
    .where(eq(userLlmConfigs.userId, userId));

  return rows;
}

/** Resolve the LLM config for a specific provider. Throws if the user has no key configured. */
export async function resolveUserLlmConfigForProvider(userId: string, provider: AllowedProvider): Promise<LlmConfig> {
  const cfg = await getUserLlmConfig(userId, provider);
  if (cfg) return cfg;

  throw new AppError(422, `No API key configured for provider "${provider}". Please add your key in Settings.`, "NO_LLM_CONFIG");
}

/** Resolve any LLM config for the user (first found, then server default). Used for /v1/models. */
export async function resolveUserLlmConfig(userId: string): Promise<LlmConfig> {
  const [row] = await db
    .select()
    .from(userLlmConfigs)
    .where(eq(userLlmConfigs.userId, userId))
    .limit(1);

  if (row) {
    return {
      provider: row.provider as LlmConfig["provider"],
      apiKey: decrypt(row.encryptedApiKey),
      model: row.model,
    };
  }

  throw new AppError(422, "No LLM API key configured. Please add your key in Settings.", "NO_LLM_CONFIG");
}

export async function upsertUserLlmConfig(
  userId: string,
  provider: string,
  apiKey: string,
  model: string,
): Promise<void> {
  if (!ALLOWED_PROVIDERS.includes(provider as AllowedProvider)) {
    throw new AppError(422, `provider must be one of: ${ALLOWED_PROVIDERS.join(", ")}`, "VALIDATION_ERROR");
  }
  if (!apiKey.trim()) {
    throw new AppError(422, "apiKey is required", "VALIDATION_ERROR");
  }
  if (!model.trim()) {
    throw new AppError(422, "model is required", "VALIDATION_ERROR");
  }

  const encryptedApiKey = encrypt(apiKey);

  await db
    .insert(userLlmConfigs)
    .values({ userId, provider, encryptedApiKey, model })
    .onConflictDoUpdate({
      target: [userLlmConfigs.userId, userLlmConfigs.provider],
      set: { encryptedApiKey, model, updatedAt: new Date() },
    });
}

export async function deleteUserLlmConfig(userId: string, provider?: string): Promise<void> {
  const conditions = provider
    ? and(eq(userLlmConfigs.userId, userId), eq(userLlmConfigs.provider, provider))
    : eq(userLlmConfigs.userId, userId);

  const result = await db
    .delete(userLlmConfigs)
    .where(conditions)
    .returning({ userId: userLlmConfigs.userId });

  if (result.length === 0) throw new NotFoundError("No LLM config found");
}
