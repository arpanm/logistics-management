import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  acceptInvitation,
  api,
  login,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";

type Result = { id: string; status: "Passed" | "Failed"; evidence: string };
type KernelRecord = {
  id: string;
  code: string;
  name: string;
  status: string;
  version: number;
};

function unique(prefix: string) {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

async function json<T>(response: Awaited<ReturnType<typeof api>>) {
  return (await response.json()) as T;
}

test("30 real acceptance checks for intelligence and governance features", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const results: Result[] = [];
  const run = async (id: string, action: () => Promise<string>) => {
    await test.step(id, async () => {
      try {
        const evidence = await action();
        results.push({ id, status: "Passed", evidence });
        console.log(`ACCEPTANCE_RESULT ${id} Passed: ${evidence}`);
      } catch (error) {
        const evidence = error instanceof Error ? error.message : String(error);
        results.push({ id, status: "Failed", evidence });
        console.error(`ACCEPTANCE_RESULT ${id} Failed: ${evidence}`);
      }
    });
  };

  const tenantA = tenantFixture("IntelA");
  const tenantB = tenantFixture("IntelB");
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin);
  const provisionedA = await provisionViaApi(admin, tenantA);
  const provisionedB = await provisionViaApi(admin, tenantB);

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await acceptInvitation(pageA, provisionedA.invitationUrl, tenantA.ownerName);
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await acceptInvitation(pageB, provisionedB.invitationUrl, tenantB.ownerName);
  let controlRecordId = "";
  let alertId = "";
  let alertVersion = 1;
  let validImportId = "";
  let validClientCode = "";
  let invalidImportId = "";
  let policy: KernelRecord | undefined;
  let integrationId = "";
  let deadLetterId = "";
  let deliveryId = "";
  let setting: KernelRecord | undefined;

  try {
    await run("E2E-CTL01-01", async () => {
      const code = unique("CTL");
      const create = await api(pageA, "/modules/control/saved_view", {
        method: "POST",
        data: {
          code,
          name: `Placement view ${code}`,
          data: { lens: "placement", filters: {}, isDefault: true },
        },
      });
      expect(create.status(), await create.text()).toBe(201);
      controlRecordId = ((await create.json()) as { id: string }).id;
      await pageA.goto("/app/control");
      await expect(
        pageA.getByRole("heading", { name: "Control tower" }),
      ).toBeVisible();
      await expect(
        pageA.getByRole("heading", { name: "liveIndents" }),
      ).toBeVisible();
      const dashboard = await api(pageA, "/tenant/control/placement");
      expect(dashboard.status(), await dashboard.text()).toBe(200);
      const body = await json<{ totals: { records: number } }>(dashboard);
      const persisted = await api(
        pageA,
        `/modules/control/saved_view/${controlRecordId}`,
      );
      expect(persisted.status(), await persisted.text()).toBe(200);
      return `saved view ${controlRecordId} persisted; placement API records=${body.totals.records}`;
    });

    await run("E2E-CTL01-02", async () => {
      const beforeResponse = await api(pageA, "/modules/control/saved_view");
      const before = ((await beforeResponse.json()) as { total: number }).total;
      const response = await api(pageA, "/tenant/control/not-a-lens");
      expect(response.status(), await response.text()).toBe(400);
      const afterResponse = await api(pageA, "/modules/control/saved_view");
      const after = ((await afterResponse.json()) as { total: number }).total;
      expect(after).toBe(before);
      return `invalid lens rejected with 400; canonical record count remained ${after}`;
    });

    await run("E2E-CTL01-03", async () => {
      const anonymous = await request.get("/api/v1/tenant/control/placement");
      expect(anonymous.status(), await anonymous.text()).toBe(401);
      const other = await api(
        pageB,
        `/modules/control/saved_view/${controlRecordId}`,
      );
      expect(other.status(), await other.text()).toBe(404);
      return "anonymous denied 401 and tenant B could not fetch tenant A saved view";
    });

    await run("E2E-CTL01-04", async () => {
      await pageA.goto("/app/control");
      await pageA.getByRole("button", { name: "Pause refresh" }).click();
      await expect(
        pageA.getByRole("button", { name: "Resume live refresh" }),
      ).toBeVisible();
      await pageA.getByRole("button", { name: "Resume live refresh" }).click();
      await pageA.getByLabel("Lens").selectOption("trip");
      await expect(
        pageA.getByRole("heading", { name: "active" }),
      ).toBeVisible();
      await pageA.getByLabel("Lens").selectOption("placement");
      await expect(
        pageA.getByRole("heading", { name: "liveIndents" }),
      ).toBeVisible();
      return "pause/resume and lens switch recovered to a refreshed placement view";
    });

    await run("E2E-CTL01-05", async () => {
      const dashboardResponse = await api(pageA, "/tenant/control/placement");
      const drillResponse = await api(pageA, "/tenant/control/placement/drill");
      expect(dashboardResponse.status()).toBe(200);
      expect(drillResponse.status()).toBe(200);
      const dashboard = (await dashboardResponse.json()) as {
        totals: { records: number };
        status: Array<{ count: number }>;
      };
      const drill = (await drillResponse.json()) as Array<{ id: string }>;
      expect(
        dashboard.status.reduce((sum, row) => sum + Number(row.count), 0),
      ).toBe(drill.length);
      return `dashboard=${dashboard.totals.records}, status sum=${drill.length}, canonical drill reconciled`;
    });

    await run("E2E-ALT01-01", async () => {
      const title = unique("Delayed POD");
      const create = await api(pageA, "/modules/alerts/alert", {
        method: "POST",
        headers: { "Idempotency-Key": unique("alt-create") },
        data: {
          code: unique("ALERT"),
          name: title,
          data: {
            type: "POD_OVERDUE",
            severity: "HIGH",
            summary: "POD has crossed the configured SLA",
          },
        },
      });
      expect(create.status(), await create.text()).toBe(201);
      const created = (await create.json()) as KernelRecord;
      alertId = created.id;
      alertVersion = created.version;
      await pageA.goto("/app/alerts");
      const card = pageA
        .locator("article.access-card")
        .filter({ hasText: title });
      await expect(card).toBeVisible();
      const acknowledgeRequest = pageA.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url().endsWith(`/api/v1/tenant/alerts/${alertId}/actions`),
      );
      await card.getByRole("button", { name: "Acknowledge" }).click();
      expect((await acknowledgeRequest).headers()["idempotency-key"]).toMatch(
        /^.{8,200}$/,
      );
      await expect(card).toContainText("ACKNOWLEDGED");
      const queue = await api(pageA, "/tenant/alerts?state=ACKNOWLEDGED");
      const body = (await queue.json()) as {
        items: Array<{ id: string; version: number }>;
      };
      const persisted = body.items.find((item) => item.id === alertId);
      expect(persisted).toBeTruthy();
      alertVersion = persisted!.version;
      return `supported alert create surfaced in queue and UI action persisted v${alertVersion}`;
    });

    await run("E2E-ALT01-02", async () => {
      const response = await api(pageA, `/tenant/alerts/${alertId}/actions`, {
        method: "POST",
        headers: { "Idempotency-Key": unique("alt-invalid") },
        data: { action: "RESOLVE", expectedVersion: alertVersion },
      });
      expect(response.status(), await response.text()).toBe(400);
      const detail = await api(pageA, `/modules/alerts/alert/${alertId}`);
      expect(detail.status(), await detail.text()).toBe(200);
      expect(((await detail.json()) as KernelRecord).version).toBe(
        alertVersion,
      );
      return `resolve without reason rejected; supported alert record stayed v${alertVersion}`;
    });

    await run("E2E-ALT01-03", async () => {
      const response = await api(pageB, `/tenant/alerts/${alertId}/actions`, {
        method: "POST",
        headers: { "Idempotency-Key": unique("alt-cross-tenant") },
        data: { action: "ACKNOWLEDGE", expectedVersion: alertVersion },
      });
      expect(response.status(), await response.text()).toBe(404);
      const queue = await api(pageB, "/tenant/alerts");
      const body = (await queue.json()) as { items: Array<{ id: string }> };
      expect(body.items.some((item) => item.id === alertId)).toBe(false);
      return "tenant B action returned 404 and its queue excluded tenant A alert";
    });

    await run("E2E-ALT01-04", async () => {
      const stale = await api(pageA, `/tenant/alerts/${alertId}/actions`, {
        method: "POST",
        headers: { "Idempotency-Key": unique("alt-stale") },
        data: {
          action: "RESOLVE",
          reason: "Resolved after POD upload",
          expectedVersion: alertVersion + 1,
        },
      });
      expect(stale.status(), await stale.text()).toBe(409);
      const retry = await api(pageA, `/tenant/alerts/${alertId}/actions`, {
        method: "POST",
        headers: { "Idempotency-Key": unique("alt-resolve") },
        data: {
          action: "RESOLVE",
          reason: "Resolved after POD upload",
          expectedVersion: alertVersion,
        },
      });
      expect(retry.status(), await retry.text()).toBe(200);
      expect(await retry.json()).toMatchObject({ state: "RESOLVED" });
      alertVersion += 1;
      return `stale version rejected 409; current version resolved alert to v${alertVersion}`;
    });

    await run("E2E-ALT01-05", async () => {
      const response = await api(pageA, "/tenant/alerts?state=RESOLVED");
      const body = (await response.json()) as {
        items: Array<{ id: string; state: string }>;
        total: number;
      };
      expect(body.total).toBe(body.items.length);
      expect(body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: alertId, state: "RESOLVED" }),
        ]),
      );
      return `resolved queue total=${body.total} reconciled to returned rows`;
    });

    await run("E2E-DAT01-01", async () => {
      validClientCode = unique("CLIENT");
      const csv = `Client Code,Client Name,Account Manager,Credit Days\n${validClientCode},Acceptance Client,Manager One,30\n`;
      await pageA.goto("/app/data");
      await pageA.getByLabel("Dataset").selectOption("CLIENT");
      await pageA.getByLabel("CSV file").setInputFiles({
        name: `${validClientCode}.csv`,
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
      await pageA
        .getByRole("button", { name: "Validate complete file" })
        .click();
      await expect(
        pageA.getByRole("heading", { name: "VALIDATED" }),
      ).toBeVisible();
      const statusBefore = await api(pageA, "/tenant/imports/status");
      const jobsBefore = (await statusBefore.json()) as Array<{
        id: string;
        filename: string;
        version: number;
      }>;
      const job = jobsBefore.find(
        (item) => item.filename === `${validClientCode}.csv`,
      )!;
      expect(job).toBeTruthy();
      validImportId = job.id;
      await pageA.getByRole("button", { name: "Commit import" }).click();
      await expect(pageA.getByText(`${validClientCode}.csv`)).toBeVisible();
      await expect(pageA.getByText(/CLIENT · COMMITTED/)).toBeVisible();
      return `real CSV preview ${validImportId} committed through UI`;
    });

    await run("E2E-DAT01-02", async () => {
      const invalidCode = unique("BADCLIENT");
      const partiesBefore = await api(pageA, "/modules/masters/parties");
      const before = (await partiesBefore.json()) as { total: number };
      const response = await api(pageA, "/tenant/imports/preview", {
        method: "POST",
        headers: { "Idempotency-Key": unique("bad-import") },
        data: {
          dataset: "CLIENT",
          filename: `${invalidCode}.csv`,
          mediaType: "text/csv",
          byteSize: 12,
          checksum: createHash("sha256").update(invalidCode).digest("hex"),
          sourceTimezone: "Asia/Kolkata",
          importMode: "UPSERT",
          headers: ["Client Code"],
          rows: [{ "Client Code": invalidCode }],
        },
      });
      expect(response.status(), await response.text()).toBe(201);
      const failed = (await response.json()) as { id: string; state: string };
      invalidImportId = failed.id;
      expect(failed.state).toBe("FAILED");
      const errors = await api(
        pageA,
        `/tenant/imports/${invalidImportId}/errors`,
      );
      expect(await errors.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "MISSING_HEADER" }),
        ]),
      );
      const partiesAfter = await api(pageA, "/modules/masters/parties");
      const after = (await partiesAfter.json()) as { total: number };
      expect(after.total).toBe(before.total);
      return `failed job ${invalidImportId} recorded errors without target mutation`;
    });

    await run("E2E-DAT01-03", async () => {
      const response = await api(
        pageB,
        `/tenant/imports/${invalidImportId}/errors`,
      );
      expect(response.status(), await response.text()).toBe(200);
      expect(await response.json()).toEqual([]);
      const anonymous = await request.get("/api/v1/tenant/imports/status");
      expect(anonymous.status(), await anonymous.text()).toBe(401);
      return "tenant B received no tenant A import errors; anonymous status denied 401";
    });

    await run("E2E-DAT01-04", async () => {
      const code = unique("RETRYCLIENT");
      const preview = await api(pageA, "/tenant/imports/preview", {
        method: "POST",
        headers: { "Idempotency-Key": unique("retry-import") },
        data: {
          dataset: "CLIENT",
          filename: `${code}.csv`,
          mediaType: "text/csv",
          byteSize: 100,
          checksum: createHash("sha256").update(code).digest("hex"),
          sourceTimezone: "Asia/Kolkata",
          importMode: "UPSERT",
          headers: [
            "Client Code",
            "Client Name",
            "Account Manager",
            "Credit Days",
          ],
          rows: [
            {
              "Client Code": code,
              "Client Name": "Retry Client",
              "Account Manager": "Manager Two",
              "Credit Days": "45",
            },
          ],
        },
      });
      expect(preview.status(), await preview.text()).toBe(201);
      const job = (await preview.json()) as { id: string; version: number };
      const stale = await api(pageA, `/tenant/imports/${job.id}/commit`, {
        method: "POST",
        data: { expectedVersion: job.version + 1 },
      });
      expect(stale.status(), await stale.text()).toBe(409);
      const retry = await api(pageA, `/tenant/imports/${job.id}/commit`, {
        method: "POST",
        data: { expectedVersion: job.version },
      });
      expect(retry.status(), await retry.text()).toBe(200);
      expect(await retry.json()).toMatchObject({ state: "COMMITTED" });
      return `job ${job.id} rejected stale version and committed on safe retry`;
    });

    await run("E2E-DAT01-05", async () => {
      const status = await api(
        pageA,
        `/tenant/imports/status?jobId=${validImportId}`,
      );
      const jobs = (await status.json()) as Array<{
        state: string;
        summary: {
          rows: number;
          created: number;
          updated: number;
          unchanged: number;
        };
      }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.state).toBe("COMMITTED");
      const list = await api(
        pageA,
        `/modules/masters/parties?search=${encodeURIComponent(validClientCode)}`,
      );
      const body = (await list.json()) as {
        items: Array<{ code: string }>;
        total: number;
      };
      expect(body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: validClientCode }),
        ]),
      );
      const summary = jobs[0]!.summary;
      expect(summary.created + summary.updated + summary.unchanged).toBe(
        summary.rows,
      );
      return `committed row summary reconciled (${JSON.stringify(summary)}) and target record exists`;
    });

    await run("E2E-GOV01-01", async () => {
      const code = unique("POLICY");
      await pageA.goto("/app/governance/policies");
      await pageA.getByLabel("Code").fill(code);
      await pageA.getByLabel("Name").fill("High value approval policy");
      await pageA.getByLabel("Policy type").selectOption("APPROVAL");
      await pageA.getByLabel("Applies to").fill("vendor-payable");
      await pageA.getByLabel("Rule JSON").fill('{"amountMinor":100000}');
      await pageA
        .getByRole("button", { name: "Create governance policy" })
        .click();
      await expect(pageA.getByRole("status")).toContainText(
        "Governance policy created",
      );
      const list = await api(
        pageA,
        `/modules/governance/policies?search=${code}`,
      );
      const body = (await list.json()) as { items: KernelRecord[] };
      policy = body.items.find((item) => item.code === code);
      expect(policy).toBeTruthy();
      return `policy ${policy!.id} created through UI and persisted through API`;
    });

    await run("E2E-GOV01-02", async () => {
      const before = await api(pageA, "/modules/governance/policies");
      const beforeTotal = ((await before.json()) as { total: number }).total;
      const invalid = await api(pageA, "/modules/governance/policies", {
        method: "POST",
        data: { code: "!", name: "x", data: {} },
      });
      expect(invalid.status(), await invalid.text()).toBe(400);
      const after = await api(pageA, "/modules/governance/policies");
      expect(((await after.json()) as { total: number }).total).toBe(
        beforeTotal,
      );
      return `invalid generic fields rejected; policy total remained ${beforeTotal}`;
    });

    await run("E2E-GOV01-03", async () => {
      expect(policy).toBeTruthy();
      const response = await api(
        pageB,
        `/modules/governance/policies/${policy!.id}`,
      );
      expect(response.status(), await response.text()).toBe(404);
      return "tenant B guessed policy UUID and received tenant-scoped 404";
    });

    await run("E2E-GOV01-04", async () => {
      expect(policy).toBeTruthy();
      const stale = await api(
        pageA,
        `/modules/governance/policies/${policy!.id}`,
        {
          method: "PATCH",
          data: { name: "Stale policy", expectedVersion: policy!.version + 1 },
        },
      );
      expect(stale.status(), await stale.text()).toBe(409);
      const retry = await api(
        pageA,
        `/modules/governance/policies/${policy!.id}`,
        {
          method: "PATCH",
          data: { name: "Approved policy", expectedVersion: policy!.version },
        },
      );
      expect(retry.status(), await retry.text()).toBe(200);
      policy = (await retry.json()) as KernelRecord;
      expect(policy.name).toBe("Approved policy");
      return `stale update rejected; retry persisted policy version ${policy.version}`;
    });

    await run("E2E-GOV01-05", async () => {
      const list = await api(pageA, "/modules/governance/policies");
      const report = await api(pageA, "/modules/governance/policies/report");
      const total = ((await list.json()) as { total: number }).total;
      const rows = ((await report.json()) as { rows: Array<{ count: number }> })
        .rows;
      expect(rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(total);
      await pageA.goto("/app/governance/policies");
      await pageA.getByRole("button", { name: "Status report" }).click();
      await expect(
        pageA.getByRole("heading", { name: "Status report" }),
      ).toBeVisible();
      return `status report sum reconciled to ${total} policy records and rendered in UI`;
    });

    await run("E2E-INT01-01", async () => {
      const code = unique("HOOK");
      await pageA.goto("/app/integrations");
      await pageA.getByRole("tab", { name: "new" }).click();
      await pageA.getByLabel("Code").fill(code);
      await pageA.getByLabel("Name").fill("Acceptance webhook");
      await pageA.getByLabel("Type").selectOption("WEBHOOK");
      await pageA
        .getByLabel("Endpoint")
        .fill("https://example.test/logistics/events");
      const createRequest = pageA.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url().endsWith("/api/v1/tenant/integrations"),
      );
      await pageA.getByRole("button", { name: "Create integration" }).click();
      expect((await createRequest).headers()["idempotency-key"]).toMatch(
        /^.{8,200}$/,
      );
      await expect
        .poll(async () => {
          const response = await api(pageA, "/tenant/integrations");
          const endpoints = (await response.json()) as Array<{
            id: string;
            code: string;
          }>;
          integrationId =
            endpoints.find((item) => item.code === code)?.id ?? "";
          return integrationId;
        })
        .not.toBe("");
      await pageA.getByRole("tab", { name: "health" }).click();
      await expect(pageA.getByText("Acceptance webhook")).toBeVisible();
      return `integration ${integrationId} registered through UI and persisted through API`;
    });

    await run("E2E-INT01-02", async () => {
      const before = await api(pageA, "/tenant/integrations");
      const count = ((await before.json()) as unknown[]).length;
      const invalid = await api(pageA, "/tenant/integrations", {
        method: "POST",
        headers: { "Idempotency-Key": unique("integration-invalid") },
        data: {
          code: "bad code",
          type: "WEBHOOK",
          name: "x",
          environment: "p",
          endpoint: "not-a-url",
          scopes: [],
          allowedEvents: [],
          mappingVersion: 1,
        },
      });
      expect(invalid.status(), await invalid.text()).toBe(400);
      const after = await api(pageA, "/tenant/integrations");
      expect(((await after.json()) as unknown[]).length).toBe(count);
      return `invalid registry payload rejected; endpoint count remained ${count}`;
    });

    await run("E2E-INT01-03", async () => {
      const response = await api(pageB, "/tenant/integrations");
      expect(response.status(), await response.text()).toBe(200);
      const endpoints = (await response.json()) as Array<{ id: string }>;
      expect(endpoints.some((item) => item.id === integrationId)).toBe(false);
      const anonymous = await request.get("/api/v1/tenant/integrations");
      expect(anonymous.status(), await anonymous.text()).toBe(401);
      return "tenant B registry excluded tenant A endpoint and anonymous access was denied";
    });

    await run("E2E-INT01-04", async () => {
      const deliveryCode = unique("DELIVERY");
      const deliveryData = {
        endpointId: integrationId,
        direction: "OUTBOUND",
        eventType: "trip.updated.v1",
        mappingVersion: 1,
        payload: { tripId: "TRIP-REPLAY-001", milestone: "DELIVERED" },
        reasonCode: "REMOTE_UNAVAILABLE",
        safeError: "Remote endpoint unavailable after retry policy",
      } as const;
      const create = await api(pageA, "/modules/integrations/delivery", {
        method: "POST",
        headers: { "Idempotency-Key": unique("delivery-fail-one") },
        data: {
          code: deliveryCode,
          name: "Failed outbound delivery",
          data: { ...deliveryData, expectedVersion: 1 },
        },
      });
      expect(create.status(), await create.text()).toBe(201);
      const failedOnce = (await create.json()) as {
        id: string;
        status: string;
        version: number;
      };
      expect(failedOnce).toMatchObject({ status: "DEAD_LETTER", version: 2 });
      deliveryId = failedOnce.id;
      deadLetterId = deliveryId;
      const invalid = await api(
        pageA,
        `/tenant/integrations/dead-letters/${deadLetterId}/replay`,
        {
          method: "POST",
          headers: { "Idempotency-Key": unique("replay-invalid") },
          data: { reason: "no", expectedVersion: failedOnce.version },
        },
      );
      expect(invalid.status(), await invalid.text()).toBe(400);
      const replay = await api(
        pageA,
        `/tenant/integrations/dead-letters/${deadLetterId}/replay`,
        {
          method: "POST",
          headers: { "Idempotency-Key": unique("replay-one") },
          data: {
            reason: "Operator verified remote recovery",
            expectedVersion: failedOnce.version,
          },
        },
      );
      expect(replay.status(), await replay.text()).toBe(200);
      expect(await replay.json()).toMatchObject({ replayCount: 1 });
      const failAgain = await api(pageA, "/modules/integrations/delivery", {
        method: "POST",
        headers: { "Idempotency-Key": unique("delivery-fail-two") },
        data: {
          code: deliveryCode,
          name: "Failed outbound delivery",
          data: { ...deliveryData, expectedVersion: 3 },
        },
      });
      expect(failAgain.status(), await failAgain.text()).toBe(201);
      expect(await failAgain.json()).toMatchObject({
        id: deliveryId,
        status: "DEAD_LETTER",
        version: 4,
      });
      const replayAgain = await api(
        pageA,
        `/tenant/integrations/dead-letters/${deadLetterId}/replay`,
        {
          method: "POST",
          headers: { "Idempotency-Key": unique("replay-two") },
          data: {
            reason: "Operator verified second remote recovery",
            expectedVersion: 4,
          },
        },
      );
      expect(replayAgain.status(), await replayAgain.text()).toBe(200);
      expect(await replayAgain.json()).toMatchObject({ replayCount: 2 });
      const deliveries = await api(
        pageA,
        "/tenant/integrations/deliveries?state=PENDING",
      );
      expect(await deliveries.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: deliveryId, state: "PENDING" }),
        ]),
      );
      return `supported delivery ${deliveryId} completed fail/replay twice; dead letter ${deadLetterId} replayCount=2`;
    });

    await run("E2E-INT01-05", async () => {
      const healthResponse = await api(pageA, "/tenant/integrations/health");
      const deliveriesResponse = await api(
        pageA,
        "/tenant/integrations/deliveries",
      );
      const health = (await healthResponse.json()) as Array<{
        id: string;
        deliveries: number;
        deadLetters: number;
      }>;
      const deliveries = (await deliveriesResponse.json()) as Array<{
        id: string;
      }>;
      const endpointHealth = health.find((item) => item.id === integrationId)!;
      expect(endpointHealth).toBeTruthy();
      expect(endpointHealth.deliveries).toBe(
        deliveries.filter((item) => item.id === deliveryId).length,
      );
      return `endpoint health deliveries=${endpointHealth.deliveries} reconciled to delivery log`;
    });

    await run("E2E-CFG01-01", async () => {
      const code = unique("CFG");
      const response = await api(pageA, "/modules/configuration/settings", {
        method: "POST",
        data: {
          code,
          name: "Control tower thresholds",
          data: { namespace: "control", value: { staleMinutes: 30 } },
          effectiveFrom: "2026-08-25T00:00:00.000Z",
        },
      });
      expect(response.status(), await response.text()).toBe(201);
      setting = (await response.json()) as KernelRecord;
      await pageA.goto("/app/configuration/settings");
      await pageA.getByLabel("Search").fill(code);
      await pageA.getByRole("button", { name: "Search", exact: true }).click();
      await expect(
        pageA.locator("article.record-card").filter({ hasText: code }),
      ).toBeVisible();
      return `effective-dated setting ${setting.id} persisted by API and rendered in UI`;
    });

    await run("E2E-CFG01-02", async () => {
      const before = await api(pageA, "/modules/configuration/settings");
      const count = ((await before.json()) as { total: number }).total;
      const invalid = await api(pageA, "/modules/configuration/settings", {
        method: "POST",
        data: { code: "?", name: "x", data: {} },
      });
      expect(invalid.status(), await invalid.text()).toBe(400);
      const after = await api(pageA, "/modules/configuration/settings");
      expect(((await after.json()) as { total: number }).total).toBe(count);
      return `invalid configuration rejected with no mutation; total=${count}`;
    });

    await run("E2E-CFG01-03", async () => {
      expect(setting).toBeTruthy();
      const response = await api(
        pageB,
        `/modules/configuration/settings/${setting!.id}`,
      );
      expect(response.status(), await response.text()).toBe(404);
      return "tenant B guessed configuration UUID and received scoped 404";
    });

    await run("E2E-CFG01-04", async () => {
      expect(setting).toBeTruthy();
      const stale = await api(
        pageA,
        `/modules/configuration/settings/${setting!.id}`,
        {
          method: "PATCH",
          data: {
            name: "Stale thresholds",
            expectedVersion: setting!.version + 1,
          },
        },
      );
      expect(stale.status(), await stale.text()).toBe(409);
      const retry = await api(
        pageA,
        `/modules/configuration/settings/${setting!.id}`,
        {
          method: "PATCH",
          data: {
            name: "Current thresholds",
            expectedVersion: setting!.version,
          },
        },
      );
      expect(retry.status(), await retry.text()).toBe(200);
      setting = (await retry.json()) as KernelRecord;
      expect(setting.name).toBe("Current thresholds");
      return `stale update rejected; current-version retry created immutable snapshot v${setting.version}`;
    });

    await run("E2E-CFG01-05", async () => {
      const report = await api(pageA, "/modules/configuration/settings/report");
      const list = await api(pageA, "/modules/configuration/settings");
      const rows = ((await report.json()) as { rows: Array<{ count: number }> })
        .rows;
      const total = ((await list.json()) as { total: number }).total;
      expect(rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(total);
      const detail = await api(
        pageA,
        `/modules/configuration/settings/${setting!.id}`,
      );
      const record = (await detail.json()) as {
        snapshots: unknown[];
        version: number;
      };
      expect(record.snapshots.length).toBeGreaterThanOrEqual(2);
      return `configuration report total=${total}; detail has ${record.snapshots.length} snapshots`;
    });
  } finally {
    await testInfo.attach("acceptance-results", {
      body: Buffer.from(JSON.stringify(results, null, 2)),
      contentType: "application/json",
    });
    await Promise.all([
      contextA.close(),
      contextB.close(),
      adminContext.close(),
    ]);
  }

  const failed = results.filter((result) => result.status === "Failed");
  expect(
    failed,
    `Acceptance failures:\n${failed.map((item) => `${item.id}: ${item.evidence}`).join("\n")}`,
  ).toEqual([]);
});
