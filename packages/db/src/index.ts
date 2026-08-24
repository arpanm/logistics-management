import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma, PrismaClient };

export function createDatabase(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}

export async function withPlatform<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.platform_context', 'on', true)",
    );
    return fn(tx);
  });
}

export async function withTenant<T>(
  db: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.platform_context', 'off', true)",
    );
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    return fn(tx);
  });
}
