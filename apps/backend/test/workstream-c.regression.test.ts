import { readFileSync } from "node:fs";
import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";
import { AppService } from "../src/app.service.js";

describe("BUG-GAP-003/004/011/012 focused regressions", () => {
  it("persists the fifth failed login as one deduplicated tenant alert", async () => {
    const passwordHash = await argon2.hash("CorrectPassword!234");
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM app.login_attempts")) {
        const call = query.mock.calls.filter(([text]) =>
          String(text).includes("FROM app.login_attempts"),
        ).length;
        return [{ count: call === 1 ? 4 : 5 }];
      }
      if (sql.includes("FROM app.users"))
        return [
          {
            id: "00000000-0000-4000-8000-000000000001",
            email: "actor@test.local",
            displayName: "Actor",
            passwordHash,
            platformAdmin: false,
          },
        ];
      if (sql.includes("FROM app.tenant_memberships"))
        return [
          {
            tenantId: "00000000-0000-4000-8000-000000000002",
            id: "00000000-0000-4000-8000-000000000003",
          },
        ];
      if (sql.includes("INSERT INTO app.login_attempts")) return [{}];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const tx = {
      $queryRawUnsafe: query,
      $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
        writes.push({ sql, params });
        return 1;
      }),
    };
    const service = new AppService();
    Object.assign(service, {
      db: {
        $transaction: async (run: (value: typeof tx) => unknown) => run(tx),
      },
    });

    await expect(
      service.login(
        "actor@test.local",
        "WrongPassword!234",
        "TENANT-A",
        "gap-login-5",
      ),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });

    const event = writes.find(({ sql }) =>
      sql.includes("INSERT INTO app.security_events"),
    );
    const alert = writes.find(({ sql }) =>
      sql.includes("INSERT INTO app.security_alerts"),
    );
    expect(event?.params[4]).toBe('{"attempt":5}');
    expect(alert?.sql).toContain("ON CONFLICT(tenant_id,deduplication_key)");
    expect(alert?.params[1]).toMatch(/^login:/);
  });

  it("backfills owners, compatible baseline roles and same-assignment alert scope", () => {
    const migration = readFileSync(
      new URL(
        "../../../packages/db/prisma/migrations/202608250007_all_feature_canonical/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("WHERE r.code='TENANT_OWNER' AND c.active");
    for (const role of [
      "MIS_EXECUTIVE",
      "REGIONAL_MANAGER",
      "KEY_ACCOUNT_MANAGER",
      "FINANCE_EXECUTIVE",
      "VENDOR_OWNER",
      "DRIVER",
      "CLIENT_VIEWER",
      "AUDITOR",
    ])
      expect(migration).toContain(role);
    expect(migration).toContain(
      "CREATE FUNCTION app.operational_alert_authorized",
    );
    expect(migration).toMatch(
      /domain_resource_authorized\(\s*p_tenant,p_membership,p_user,p_capability,'READ'/,
    );
  });
});
