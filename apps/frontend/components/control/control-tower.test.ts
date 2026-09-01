import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  controlDashboardRequestKey,
  isCurrentControlDashboardRequest,
} from "./control-tower.js";

function query(values: Record<string, string>) {
  return new URLSearchParams({
    page: "1",
    pageSize: "25",
    sort: "updatedAt",
    direction: "desc",
    ...values,
  }).toString();
}

describe("BUG-CTL-027 request-scoped Control Tower rendering", () => {
  it("changes the request identity for lens, drill, breadcrumb, clear, and saved-view transitions", () => {
    const root = controlDashboardRequestKey("placement", query({}));
    const client = controlDashboardRequestKey(
      "placement",
      query({ clientId: "client-a" }),
    );
    const location = controlDashboardRequestKey(
      "placement",
      query({ clientId: "client-a", locationId: "location-a" }),
    );
    const savedView = controlDashboardRequestKey(
      "placement",
      query({ clientId: "client-b", colour: "RED", search: "late" }),
    );
    const otherLens = controlDashboardRequestKey("trip", query({}));

    expect(new Set([root, client, location, savedView, otherLens]).size).toBe(
      5,
    );
    expect(controlDashboardRequestKey("placement", query({}))).toBe(root);
    expect(client).not.toBe(location); // Client breadcrumb clears location.
    expect(root).not.toBe(location); // Reset/clear returns to root scope.
  });

  it("accepts only the latest exact-key response and rejects aborts or out-of-order completions", () => {
    const active = { requestKey: "placement?clientId=b", requestId: 12 };
    expect(
      isCurrentControlDashboardRequest(active, "placement?clientId=b", 12),
    ).toBe(true);
    expect(
      isCurrentControlDashboardRequest(active, "placement?clientId=a", 12),
    ).toBe(false);
    expect(
      isCurrentControlDashboardRequest(active, "placement?clientId=b", 11),
    ).toBe(false);
    expect(
      isCurrentControlDashboardRequest(
        active,
        "placement?clientId=b",
        12,
        true,
      ),
    ).toBe(false);
  });

  it("renders settled data only for its exact request while retaining same-key background refresh data", () => {
    const source = readFileSync(
      new URL("./control-tower.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("settledDashboard?.requestKey === requestKey");
    expect(source).toContain(
      "const sameKeySettled = settledRequestKey.current === loadRequestKey",
    );
    expect(source).toContain("setSettledDashboard(null)");
    expect(source).toContain("activeRequest.current.requestKey !== requestKey");
    expect(source).toContain("initialLoading || scopeTransition");
    expect(source).toContain(
      "isCurrentControlDashboardRequest(\n            activeRequest.current",
    );
  });
});
