export const DEMO_PRODUCTION_CONFIRMATION = "SEED_PUBLIC_DEMO_DATA";

export const DEFAULT_DEMO_CREDENTIALS = {
  password: "DemoAccess!234",
  tenantOwnerEmail: "demo.owner@logistics.test",
  operationsEmail: "demo.operations@logistics.test",
  financeEmail: "demo.finance@logistics.test",
  vendorEmail: "demo.vendor@logistics.test",
  driverEmail: "demo.driver@logistics.test",
  clientEmail: "demo.client@logistics.test",
} as const;

export type DemoSeedConfig = {
  appEnv: string;
  encryptionKey: Buffer;
  rotatePassword: boolean;
  password: string;
  platformAdminEmail: string;
  tenantOwnerEmail: string;
  operationsEmail: string;
  financeEmail: string;
  vendorEmail: string;
  driverEmail: string;
  clientEmail: string;
};

export function demoSeedConfig(
  env: NodeJS.ProcessEnv = process.env,
): DemoSeedConfig {
  if (env.DEMO_DATA_ENABLED !== "true") {
    throw new Error(
      "Demo bootstrap is opt-in. Set DEMO_DATA_ENABLED=true to continue.",
    );
  }
  const appEnv = (env.APP_ENV ?? env.NODE_ENV ?? "development").toLowerCase();
  if (
    appEnv === "production" &&
    env.DEMO_DATA_PRODUCTION_CONFIRM !== DEMO_PRODUCTION_CONFIRMATION
  ) {
    throw new Error(
      `Production demo bootstrap requires DEMO_DATA_PRODUCTION_CONFIRM=${DEMO_PRODUCTION_CONFIRMATION}.`,
    );
  }
  const password = env.DEMO_USER_PASSWORD ?? DEFAULT_DEMO_CREDENTIALS.password;
  if (
    appEnv === "production" &&
    password === DEFAULT_DEMO_CREDENTIALS.password
  ) {
    throw new Error(
      "Production demo bootstrap requires a non-default DEMO_USER_PASSWORD.",
    );
  }
  if (password.length < (appEnv === "production" ? 16 : 12)) {
    throw new Error(
      `DEMO_USER_PASSWORD must be at least ${appEnv === "production" ? 16 : 12} characters`,
    );
  }
  const encryptionKey = Buffer.from(env.MFA_ENCRYPTION_KEY ?? "", "base64");
  if (encryptionKey.length !== 32) {
    throw new Error(
      "MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key for demo bank data",
    );
  }
  return {
    appEnv,
    encryptionKey,
    password,
    platformAdminEmail: (env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test")
      .trim()
      .toLowerCase(),
    rotatePassword: env.DEMO_ROTATE_PASSWORD === "true",
    tenantOwnerEmail: DEFAULT_DEMO_CREDENTIALS.tenantOwnerEmail,
    operationsEmail: DEFAULT_DEMO_CREDENTIALS.operationsEmail,
    financeEmail: DEFAULT_DEMO_CREDENTIALS.financeEmail,
    vendorEmail: DEFAULT_DEMO_CREDENTIALS.vendorEmail,
    driverEmail: DEFAULT_DEMO_CREDENTIALS.driverEmail,
    clientEmail: DEFAULT_DEMO_CREDENTIALS.clientEmail,
  };
}
