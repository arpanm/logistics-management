import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/app.service.js";
import {
  exactMinorSchema,
  nonNegativeMinorSchema,
  positiveMinorSchema,
} from "../src/modules/canonical/advanced.controller.js";
import { AdvancedDomainService } from "../src/modules/canonical/advanced.service.js";
import { OperationalWorkerService } from "../src/modules/canonical/workers.service.js";

const actor = {
  activeTenantId: "00000000-0000-4000-8000-000000000001",
  membershipId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
} as never;

describe("BUG-GAP-006/009/010 focused domain integrity", () => {
  it("accepts bigint-safe decimal strings and rejects JSON numbers", () => {
    const beyondSafeInteger = "900719925474099312345678";
    expect(exactMinorSchema.parse(`-${beyondSafeInteger}`)).toBe(
      `-${beyondSafeInteger}`,
    );
    expect(nonNegativeMinorSchema.parse(beyondSafeInteger)).toBe(
      beyondSafeInteger,
    );
    expect(positiveMinorSchema.parse(beyondSafeInteger)).toBe(
      beyondSafeInteger,
    );
    expect(() => positiveMinorSchema.parse(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => nonNegativeMinorSchema.parse("01")).toThrow();
  });

  it("denies an arbitrary identifier when concrete resource scope fails", async () => {
    const calls: unknown[][] = [];
    const tx = {
      $queryRawUnsafe: async (...args: unknown[]) => {
        calls.push(args);
        return calls.length === 1 ? [{ allowed: true }] : [{ allowed: false }];
      },
    };
    const service = new AdvancedDomainService({} as never);
    const resourceAccess = Reflect.get(service, "resourceAccess") as (
      ...args: unknown[]
    ) => Promise<void>;
    await expect(
      resourceAccess.call(
        service,
        tx,
        actor,
        "finance.admin",
        "UPDATE",
        "invoices",
        "00000000-0000-4000-8000-000000000004",
      ),
    ).rejects.toMatchObject<AppError>({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
    });
    expect(String(calls[1]?.[0])).toContain("domain_resource_authorized");
    expect(calls[1]?.slice(-2)).toEqual([
      "invoices",
      "00000000-0000-4000-8000-000000000004",
    ]);
  });

  it("does not attest benign content as malware-clean without a scanner", async () => {
    const writes: string[] = [];
    const tx = {
      $queryRawUnsafe: async () => [
        {
          id: "00000000-0000-4000-8000-000000000010",
          tenantId: actor.activeTenantId,
          documentId: "00000000-0000-4000-8000-000000000011",
          content: Buffer.from("ordinary document"),
        },
      ],
      $executeRawUnsafe: async (sql: string) => {
        writes.push(sql);
        return 1;
      },
    };
    const worker = new OperationalWorkerService({} as never);
    const scan = Reflect.get(worker, "documentScans") as (
      tx: unknown,
      limit: number,
    ) => Promise<number>;
    expect(await scan.call(worker, tx, 10)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("records local notification and integration adapters as unavailable", async () => {
    const notificationWrites: string[] = [];
    const notificationTx = {
      $queryRawUnsafe: async () => [
        { id: "n", tenantId: actor.activeTenantId, attempts: 0 },
      ],
      $executeRawUnsafe: async (sql: string) => {
        notificationWrites.push(sql);
        return 1;
      },
    };
    const worker = new OperationalWorkerService({} as never);
    const notifications = Reflect.get(worker, "notificationDeliveries") as (
      tx: unknown,
      limit: number,
    ) => Promise<number>;
    await notifications.call(worker, notificationTx, 10);
    expect(notificationWrites.join("\n")).toContain("SUPPRESSED");
    expect(notificationWrites.join("\n")).toContain(
      "LOCAL_ADAPTER_UNAVAILABLE",
    );
    expect(notificationWrites.join("\n")).not.toContain("'DELIVERED'");

    const integrationWrites: string[] = [];
    const integrationArguments: unknown[][] = [];
    const integrationTx = {
      $queryRawUnsafe: async () => [
        {
          id: "00000000-0000-4000-8000-000000000020",
          tenant_id: actor.activeTenantId,
          attempts: 0,
          endpoint: "local://test",
          retry_policy: { maxAttempts: 3 },
        },
      ],
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        integrationWrites.push(sql);
        integrationArguments.push(args);
        return 1;
      },
    };
    const integrations = Reflect.get(worker, "integrationDeliveries") as (
      tx: unknown,
      limit: number,
    ) => Promise<number>;
    await integrations.call(worker, integrationTx, 10);
    expect(integrationArguments.flat()).toContain("RETRY");
    expect(integrationWrites.join("\n")).toContain("LOCAL_ADAPTER_UNAVAILABLE");
    expect(integrationWrites.join("\n")).not.toContain("SUCCEEDED");
  });

  it("authorizes every vendor bill linked to a payment batch", async () => {
    const service = new AdvancedDomainService({} as never);
    const checked: string[] = [];
    Reflect.set(
      service,
      "resourceAccess",
      async (
        _tx: unknown,
        _actor: unknown,
        _capability: string,
        _action: string,
        _resource: string,
        resourceId: string,
      ) => checked.push(resourceId),
    );
    const paymentBatchAccess = Reflect.get(service, "paymentBatchAccess") as (
      tx: unknown,
      actor: unknown,
      batchId: string,
      action: string,
    ) => Promise<void>;
    await paymentBatchAccess.call(
      service,
      {
        $queryRawUnsafe: async () => [
          { vendorBillId: "00000000-0000-4000-8000-000000000031" },
          { vendorBillId: "00000000-0000-4000-8000-000000000032" },
        ],
      },
      actor,
      "00000000-0000-4000-8000-000000000030",
      "APPROVE",
    );
    expect(checked).toEqual([
      "00000000-0000-4000-8000-000000000031",
      "00000000-0000-4000-8000-000000000032",
    ]);
  });

  it("serializes raw bigint rows and audit snapshots safely", async () => {
    const auditCalls: unknown[][] = [];
    const tx = {
      $executeRawUnsafe: async (...args: unknown[]) => {
        auditCalls.push(args);
        return 1;
      },
    };
    const db = {
      $transaction: async (execute: (transaction: unknown) => unknown) =>
        execute(tx),
    };
    const service = new AdvancedDomainService({ db } as never);
    const safeTenant = Reflect.get(service, "safeTenant") as (
      tenant: string,
      execute: (transaction: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    await expect(
      safeTenant.call(service, actor.activeTenantId, async () => ({
        id: 9_007_199_254_740_993n,
        nested: [1n],
      })),
    ).resolves.toEqual({ id: "9007199254740993", nested: ["1"] });

    const audit = Reflect.get(service, "audit") as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await audit.call(
      service,
      tx,
      actor,
      "contract.version_created",
      "contract",
      "00000000-0000-4000-8000-000000000040",
      "correlation",
      { amount: 9_007_199_254_740_993n },
      { amount: 9_007_199_254_740_994n },
    );
    expect(String(auditCalls.at(-1)?.[0])).toContain("before_json,after_json");
    expect(auditCalls.at(-1)?.[7]).toBe('{"amount":"9007199254740993"}');
    expect(auditCalls.at(-1)?.[8]).toBe('{"amount":"9007199254740994"}');
  });

  it("ships forward-only approval, alert-scope and capability repairs", () => {
    const migration = readFileSync(
      new URL(
        "../../../packages/db/prisma/migrations/202608250008_all_feature_gap_repairs/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("approval_decision_id");
    expect(migration).toContain("alert_rule_scope_authorized");
    expect(migration).toContain("alert_rule_authorized");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION app.domain_resource_authorized",
    );
    expect(migration).toContain("INSERT INTO app.role_capabilities");

    const service = readFileSync(
      new URL("../src/modules/canonical/advanced.service.ts", import.meta.url),
      "utf8",
    );
    expect(service).toContain("FROM app.approval_decisions");
    expect(service).toContain("APPROVAL_REQUIRED");

    const alerts = readFileSync(
      new URL("../src/modules/alerts/alerts.provider.ts", import.meta.url),
      "utf8",
    );
    expect(alerts).toContain("app.alert_rule_authorized");
    expect(alerts).toContain("app.alert_rule_scope_authorized");
  });
});
