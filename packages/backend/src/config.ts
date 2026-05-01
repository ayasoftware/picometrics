import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  LLM_PROVIDER: z.enum(["openai", "anthropic", "google"]).default("openai"),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default("gpt-4o"),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),

  TOKEN_ENCRYPTION_KEY: z.string().length(64), // 32 bytes hex
  INTERNAL_API_SECRET: z.string().min(16),
  OPEN_WEBUI_API_KEY: z.string().min(16),
  WEBUI_SECRET_KEY: z.string().min(16),

  MCP_GTM_URL: z.string().url().default("http://localhost:3100"),
  MCP_GOOGLE_ADS_URL: z.string().url().default("http://localhost:3101"),
  MCP_LINKEDIN_ADS_URL: z.string().url().default("http://localhost:3102"),
  MCP_FACEBOOK_ADS_URL: z.string().url().default("http://localhost:3103"),
  MCP_GOOGLE_ANALYTICS_URL: z.string().url().default("http://localhost:3104"),

  PROVISIONING_BASE_PORT:        z.coerce.number().default(18800),
  PROVISIONING_DOCKER_SOCKET:    z.string().default("/var/run/docker.sock"),
  PROVISIONING_BASE_DOMAIN:      z.string().default("openclaw.picometrics.io"),
  PROVISIONING_OPENCLAW_IMAGE:   z.string().default("ghcr.io/openclaw/openclaw:latest"),
  OPENCLAW_DOCKER_NETWORK:       z.string().default("marketing-ai-platform_openclaw_internal"),
  CADDY_ADMIN_URL:               z.string().url().default("http://caddy:2019"),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().default(""),
  LINKEDIN_CLIENT_ID: z.string().default(""),
  LINKEDIN_CLIENT_SECRET: z.string().default(""),
  FACEBOOK_APP_ID: z.string().default(""),
  FACEBOOK_APP_SECRET: z.string().default(""),
  OAUTH_REDIRECT_BASE_URL: z.string().url().default("http://localhost:4000"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
