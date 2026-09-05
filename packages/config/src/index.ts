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
  EMAIL_DELIVERY_PROVIDER: z.enum(["disabled", "ses"]).default("disabled"),
  AWS_REGION: z.string().min(1).default("eu-north-1"),
  SES_FROM_EMAIL: z.string().email().or(z.literal("")).default(""),
  EMAIL_TOKEN_ENCRYPTION_KEY: z.string().default(""),
  INVITATION_DELIVERY_POLL_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(300)
    .default(15),
  INVITATION_DELIVERY_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3),
  MFA_ENCRYPTION_KEY: z.string().default(""),
  MFA_KEY_VERSION: z.coerce.number().int().positive().default(1),
  SUPPORTED_COUNTRIES: z.string().default("AE,GB,IN,SG,US"),
  SUPPORTED_CURRENCIES: z.string().default("AED,EUR,GBP,INR,SGD,USD"),
  CONVERSATION_INTENT_PROVIDER: z
    .enum(["deterministic", "disabled"])
    .default("deterministic"),
  WHATSAPP_PROVIDER: z.enum(["disabled", "meta"]).default("disabled"),
  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z
    .string()
    .regex(/^[0-9]+$/)
    .or(z.literal(""))
    .default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_GRAPH_API_VERSION: z
    .string()
    .regex(/^v[0-9]+\.[0-9]+$/)
    .default("v23.0"),
  WHATSAPP_ALERT_TEMPLATE_NAME: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .default("logistics_operational_alert"),
  WHATSAPP_TEMPLATE_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/)
    .default("en"),
  WHATSAPP_ADDRESS_ENCRYPTION_KEY: z.string().default(""),
  WHATSAPP_ADDRESS_PEPPER: z.string().default(""),
  WHATSAPP_DELIVERY_POLL_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(300)
    .default(15),
  WHATSAPP_DELIVERY_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5),
});
export type RuntimeConfig = z.infer<typeof schema>;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isRequestOriginAllowed(
  requestOrigin: string,
  config: Pick<RuntimeConfig, "APP_ENV" | "FRONTEND_URL">,
): boolean {
  try {
    const expected = new URL(config.FRONTEND_URL);
    const actual = new URL(requestOrigin);
    if (actual.origin === expected.origin) return true;
    if (config.APP_ENV === "production") return false;
    return (
      loopbackHosts.has(actual.hostname) &&
      loopbackHosts.has(expected.hostname) &&
      actual.protocol === expected.protocol &&
      actual.port === expected.port
    );
  } catch {
    return false;
  }
}

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
  if (cfg.EMAIL_DELIVERY_PROVIDER === "ses") {
    if (!cfg.SES_FROM_EMAIL)
      throw new Error(
        "SES_FROM_EMAIL is required when EMAIL_DELIVERY_PROVIDER=ses",
      );
    if (!cfg.EMAIL_TOKEN_ENCRYPTION_KEY)
      throw new Error(
        "EMAIL_TOKEN_ENCRYPTION_KEY is required when EMAIL_DELIVERY_PROVIDER=ses",
      );
    if (
      cfg.APP_ENV === "production" &&
      new URL(cfg.FRONTEND_URL).protocol !== "https:"
    )
      throw new Error(
        "FRONTEND_URL must use HTTPS when SES delivery is enabled in production",
      );
    if (cfg.APP_ENV === "production") {
      const hostname = new URL(cfg.FRONTEND_URL).hostname;
      if (["localhost", "127.0.0.1", "[::1]"].includes(hostname))
        throw new Error(
          "FRONTEND_URL must use a public non-loopback host when SES delivery is enabled in production",
        );
    }
  }
  if (cfg.APP_ENV === "production" && !cfg.MFA_ENCRYPTION_KEY)
    throw new Error("MFA_ENCRYPTION_KEY is required in production");
  if (cfg.MFA_ENCRYPTION_KEY) {
    const key = Buffer.from(cfg.MFA_ENCRYPTION_KEY, "base64");
    if (key.length !== 32)
      throw new Error(
        "MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
      );
  }
  if (cfg.EMAIL_TOKEN_ENCRYPTION_KEY) {
    const key = Buffer.from(cfg.EMAIL_TOKEN_ENCRYPTION_KEY, "base64");
    if (key.length !== 32)
      throw new Error(
        "EMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
      );
  }
  if (cfg.WHATSAPP_PROVIDER === "meta") {
    if (cfg.WHATSAPP_APP_SECRET.length < 32)
      throw new Error(
        "WHATSAPP_APP_SECRET must be at least 32 characters when WhatsApp is enabled",
      );
    if (cfg.WHATSAPP_VERIFY_TOKEN.length < 16)
      throw new Error(
        "WHATSAPP_VERIFY_TOKEN must be at least 16 characters when WhatsApp is enabled",
      );
    if (!cfg.WHATSAPP_PHONE_NUMBER_ID)
      throw new Error(
        "WHATSAPP_PHONE_NUMBER_ID is required when WhatsApp is enabled",
      );
    if (cfg.WHATSAPP_ACCESS_TOKEN.length < 20)
      throw new Error(
        "WHATSAPP_ACCESS_TOKEN must be configured when WhatsApp is enabled",
      );
    const addressKey = Buffer.from(
      cfg.WHATSAPP_ADDRESS_ENCRYPTION_KEY,
      "base64",
    );
    if (addressKey.length !== 32)
      throw new Error(
        "WHATSAPP_ADDRESS_ENCRYPTION_KEY must be a base64-encoded 32-byte key when WhatsApp is enabled",
      );
    if (cfg.WHATSAPP_ADDRESS_PEPPER.length < 32)
      throw new Error(
        "WHATSAPP_ADDRESS_PEPPER must be at least 32 characters when WhatsApp is enabled",
      );
  }
  return cfg;
}
