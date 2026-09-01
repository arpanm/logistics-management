import type { DemoSeedConfig } from "./demo-seed-config.js";

export const JURIGARI_PRODUCTION_CONFIRMATION = "SEED_JURIGARI_PRODUCTION_DATA";
export const JURIGARI_TWELVE_CHARACTER_CONFIRMATION =
  "I_ACCEPT_DEDICATED_12_CHAR_JURIGARI_PASSWORD";

export const JURIGARI_ADOPTION_CONFIRMATION = "ADOPT_EXISTING_JURIGARI_TENANT";

export type JurigariSeedConfig = DemoSeedConfig & {
  adoption?: {
    tenantId: string;
    legalEntityId: string;
    rootOrganizationId: string;
    tenantScopeId: string;
    legalScopeId: string;
    ownerMembershipId: string;
  };
};

export function jurigariSeedConfig(
  env: NodeJS.ProcessEnv = process.env,
): JurigariSeedConfig {
  if (env.JURIGARI_DATA_ENABLED !== "true") {
    throw new Error(
      "Jurigari bootstrap is opt-in. Set JURIGARI_DATA_ENABLED=true to continue.",
    );
  }
  const appEnv = (env.APP_ENV ?? env.NODE_ENV ?? "development").toLowerCase();
  if (
    appEnv === "production" &&
    env.JURIGARI_DATA_PRODUCTION_CONFIRM !== JURIGARI_PRODUCTION_CONFIRMATION
  ) {
    throw new Error(
      `Production Jurigari bootstrap requires JURIGARI_DATA_PRODUCTION_CONFIRM=${JURIGARI_PRODUCTION_CONFIRMATION}.`,
    );
  }
  const password = env.JURIGARI_USER_PASSWORD ?? "";
  if (password.length < 12) {
    throw new Error("JURIGARI_USER_PASSWORD must be at least 12 characters");
  }
  if (appEnv === "production" && password.length < 16) {
    if (
      env.JURIGARI_ALLOW_12_CHAR_PRODUCTION_PASSWORD !== "true" ||
      env.JURIGARI_12_CHAR_PASSWORD_CONFIRM !==
        JURIGARI_TWELVE_CHARACTER_CONFIRMATION
    ) {
      throw new Error(
        `A 12-15 character production Jurigari password requires JURIGARI_ALLOW_12_CHAR_PRODUCTION_PASSWORD=true and JURIGARI_12_CHAR_PASSWORD_CONFIRM=${JURIGARI_TWELVE_CHARACTER_CONFIRMATION}. Prefer at least 16 characters.`,
      );
    }
  }
  const encryptionKey = Buffer.from(env.MFA_ENCRYPTION_KEY ?? "", "base64");
  if (encryptionKey.length !== 32) {
    throw new Error(
      "MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key for protected demo bank data",
    );
  }
  const adoptTenantId = env.JURIGARI_ADOPT_TENANT_ID?.trim();
  let adoption: JurigariSeedConfig["adoption"];
  if (adoptTenantId) {
    if (
      env.JURIGARI_ADOPT_EXISTING_TENANT_CONFIRM !==
      JURIGARI_ADOPTION_CONFIRMATION
    ) {
      throw new Error(
        `Existing-tenant adoption requires JURIGARI_ADOPT_EXISTING_TENANT_CONFIRM=${JURIGARI_ADOPTION_CONFIRMATION}.`,
      );
    }
    const values = {
      tenantId: adoptTenantId,
      legalEntityId: env.JURIGARI_ADOPT_LEGAL_ENTITY_ID?.trim() ?? "",
      rootOrganizationId: env.JURIGARI_ADOPT_ROOT_ORGANIZATION_ID?.trim() ?? "",
      tenantScopeId: env.JURIGARI_ADOPT_TENANT_SCOPE_ID?.trim() ?? "",
      legalScopeId: env.JURIGARI_ADOPT_LEGAL_SCOPE_ID?.trim() ?? "",
      ownerMembershipId: env.JURIGARI_ADOPT_OWNER_MEMBERSHIP_ID?.trim() ?? "",
    };
    for (const [name, value] of Object.entries(values)) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        )
      ) {
        throw new Error(`JURIGARI adoption ${name} must be a version-4 UUID`);
      }
    }
    adoption = values;
  }
  return {
    appEnv,
    encryptionKey,
    password,
    platformAdminEmail: (env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test")
      .trim()
      .toLowerCase(),
    rotatePassword: env.JURIGARI_ROTATE_PASSWORD === "true",
    tenantOwnerEmail: "piyana10@gmail.com",
    operationsEmail: "siddhartha09@gmail.com",
    financeEmail: "siddhartha09@gmail.com",
    vendorEmail: "siddhartha09@gmail.com",
    driverEmail: "siddhartha09@gmail.com",
    clientEmail: "piyana10@gmail.com",
    adoption,
  };
}
