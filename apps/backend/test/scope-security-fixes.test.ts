import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/app.service.js";
import { calculateMoneyLine, toJsonSafe } from "@logistics/domain";
import { CanonicalService } from "../src/modules/canonical/canonical.service.js";
import { DataProvider } from "../src/modules/data/data.provider.js";

const actor = {
  activeTenantId: "00000000-0000-4000-8000-000000000001",
  membershipId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
};

describe("BUG-GAP-006/007/008 canonical scope security", () => {
  it("reveals each sensitive category only through its explicit scoped capability", async () => {
    const service = new CanonicalService({
      requireTenant: () => actor.activeTenantId,
    } as never);
    const query = vi.fn().mockResolvedValue([
      { capability: "sensitive.mobile.read", allowed: true },
      { capability: "sensitive.payment.read", allowed: false },
      { capability: "sensitive.tax_identifier.read", allowed: false },
    ]);
    const projected = await (
      service as unknown as {
        project: (
          tx: unknown,
          subject: unknown,
          resource: string,
          row: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).project({ $queryRawUnsafe: query }, actor, "vendors", {
      id: "00000000-0000-4000-8000-000000000004",
      pan: "ABCDE1234F",
      mobile: "+919999999999",
      amount_minor: 12500,
    });

    expect(projected).toMatchObject({
      pan: "••••",
      mobile: "+919999999999",
      amount_minor: "••••",
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "app.domain_resource_authorized",
    );
    expect(query.mock.calls[0]?.[6]).toContain("sensitive.tax_identifier.read");
  });

  it("returns non-disclosing not-found when a same-tenant resource is outside scope", async () => {
    const service = new CanonicalService({
      requireTenant: () => actor.activeTenantId,
    } as never);
    const check = (
      service as unknown as {
        assertResourceScope: (...args: unknown[]) => Promise<void>;
      }
    ).assertResourceScope(
      { $queryRawUnsafe: vi.fn().mockResolvedValue([{ allowed: false }]) },
      actor,
      "operations.admin",
      "UPDATE",
      "indents",
      "00000000-0000-4000-8000-000000000005",
    );
    await expect(check).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("requires import capability and scope grant on the same active assignment", async () => {
    const provider = new DataProvider({} as never);
    const check = (
      provider as unknown as {
        importAccess: (...args: unknown[]) => Promise<unknown>;
      }
    ).importAccess(
      { $queryRawUnsafe: vi.fn().mockResolvedValue([]) },
      actor,
      "CREATE",
    );
    await expect(check).rejects.toBeInstanceOf(AppError);
    await expect(check).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  it("keeps scoped authorization at every generic and governed query boundary", () => {
    const canonical = readFileSync(
      new URL("../src/modules/canonical/canonical.service.ts", import.meta.url),
      "utf8",
    );
    expect(canonical).toContain(
      "async report(actor: SessionActor, resource: string)",
    );
    expect(canonical).toMatch(
      /SELECT coalesce\([\s\S]+app\.domain_resource_authorized\([\s\S]+GROUP BY 1/,
    );
    expect(canonical).toContain("const target = this.governedTarget");
    expect(canonical).toContain('"GOVERNED_TARGET_INVALID"');
    expect(canonical).toContain("private async createScopeNode");
  });

  it("imports assign scope and authorize every canonical reference", () => {
    const data = readFileSync(
      new URL("../src/modules/data/data.provider.ts", import.meta.url),
      "utf8",
    );
    expect(data).toContain("private async assertImportResource");
    expect(data).toContain("private async importScopeNode");
    expect(data).toMatch(
      /INSERT INTO app\.clients\([\s\S]+authorization_scope_node_id/,
    );
    expect(data).toMatch(
      /INSERT INTO app\.vendors\([\s\S]+authorization_scope_node_id/,
    );
    expect(data).toMatch(
      /INSERT INTO app\.client_locations\([\s\S]+authorization_scope_node_id/,
    );
    for (const resource of [
      "clients",
      "client-locations",
      "organization-nodes",
      "vendors",
      "pod-tasks",
      "receipts",
      "invoices",
      "lanes",
      "indents",
    ])
      expect(data).toContain(`"${resource}"`);
  });

  it("serializes nested PostgreSQL bigint values before JSON boundaries", () => {
    expect(
      toJsonSafe({ amount: 9_007_199_254_740_993n, rows: [{ tax: 18n }] }),
    ).toEqual({
      amount: "9007199254740993",
      rows: [{ tax: "18" }],
    });
  });

  it("calculates invoice values with exact integer rounding beyond Number safety", () => {
    expect(calculateMoneyLine("9007199254740993", "1001", 1800)).toEqual({
      taxableMinor: "9016206453995734",
      taxMinor: "1622917161719232",
      totalMinor: "10639123615714966",
    });
  });

  it("binds import mutation to its uploader, membership and original scopes", async () => {
    const provider = new DataProvider({} as never) as unknown as {
      importAccess: ReturnType<typeof vi.fn>;
      assertImportJobBinding: (...args: unknown[]) => Promise<void>;
    };
    provider.importAccess = vi
      .fn()
      .mockResolvedValue([
        { scopeNodeId: "00000000-0000-4000-8000-000000000006" },
      ]);
    await expect(
      provider.assertImportJobBinding({}, actor, "UPDATE", {
        uploaderId: "00000000-0000-4000-8000-000000000099",
        headerMap: {
          __authorization: {
            membershipId: actor.membershipId,
            scopeNodeIds: ["00000000-0000-4000-8000-000000000006"],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", status: 404 });
    await expect(
      provider.assertImportJobBinding({}, actor, "UPDATE", {
        uploaderId: actor.userId,
        headerMap: {
          __authorization: {
            membershipId: actor.membershipId,
            scopeNodeIds: ["00000000-0000-4000-8000-000000000007"],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "IMPORT_SCOPE_CHANGED", status: 403 });
  });

  it("uses BigInt receipt allocation and preserves frontend minor strings", () => {
    const canonical = readFileSync(
      new URL("../src/modules/canonical/canonical.service.ts", import.meta.url),
      "utf8",
    );
    const frontend = readFileSync(
      new URL(
        "../../frontend/components/canonical/canonical-workspace.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(canonical).toContain("const allocationAmount = BigInt");
    expect(canonical).not.toMatch(/used \+ input\.amountMinor/);
    expect(frontend).toContain(
      "/Minor$/.test(field.key) ? value : Number(value)",
    );
    expect(frontend).toContain("amountMinor: command.amountMinor");
    expect(frontend).not.toContain("amountMinor: Number(command.amountMinor)");
  });
});
