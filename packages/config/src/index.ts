import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_ENV: z.enum(["local", "test", "production"]).default("local"),
  DATABASE_URL: z.string().url(),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_URL: z.string().url().default("http://127.0.0.1:3000"),
  AUTH_SECRET: z.string().min(16),
  PLATFORM_ADMIN_EMAIL: z.string().email().default("admin@local.test"),
  PLATFORM_ADMIN_PASSWORD: z.string().min(12).default("LocalAdmin!234"),
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  ENABLE_TEST_HOOKS: z.enum(["true", "false"]).default("false"),
  MFA_ENCRYPTION_KEY: z.string().default(""),
  MFA_KEY_VERSION: z.coerce.number().int().positive().default(1),
  SUPPORTED_COUNTRIES: z.string().default("AE,GB,IN,SG,US"),
  SUPPORTED_CURRENCIES: z.string().default("AED,EUR,GBP,INR,SGD,USD"),
});
export type RuntimeConfig = z.infer<typeof schema>;
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const cfg = schema.parse(env);
  if (
    cfg.APP_ENV === "production" &&
    (cfg.AUTH_SECRET.includes("replace") ||
      cfg.PLATFORM_ADMIN_PASSWORD === "LocalAdmin!234")
  )
    throw new Error("Production secrets must be explicitly configured");
  if (cfg.APP_ENV === "production" && cfg.ENABLE_TEST_HOOKS === "true")
    throw new Error("Test hooks cannot be enabled in production");
  if (cfg.APP_ENV === "production" && !cfg.MFA_ENCRYPTION_KEY)
    throw new Error("MFA_ENCRYPTION_KEY is required in production");
  if (cfg.MFA_ENCRYPTION_KEY) {
    const key = Buffer.from(cfg.MFA_ENCRYPTION_KEY, "base64");
    if (key.length !== 32)
      throw new Error(
        "MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
      );
  }
  return cfg;
}
