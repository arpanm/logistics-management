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

describe("UI-03 / CTL-01 operations-console presentation contract", () => {
  it("keeps mobile controls compact and portfolio cards faithful to the command-board hierarchy", () => {
    const controlTower = readFileSync(
      new URL("./control-tower.tsx", import.meta.url),
      "utf8",
    );

    expect(controlTower).toContain('window.matchMedia("(min-width: 768px)")');
    expect(controlTower).toContain("className={styles.actionIcon}");
    expect(controlTower).toContain('aria-label="Save current view"');
    expect(controlTower).toContain('aria-label="Download matching CSV"');
    expect(controlTower).toContain(
      "className={`${styles.panel} ${styles.filterDisclosure}`}",
    );
    expect(controlTower).toContain("open={filtersOpen}");
    expect(controlTower).toContain("className={styles.filterSummary}");
    expect(controlTower).toContain("className={styles.filterBody}");

    expect(controlTower).toContain("signals?: SummarySignal[]");
    expect(controlTower).toContain("const signals = summary.signals ?? []");
    expect(controlTower).toContain("className={styles.clientMonogram}");
    expect(controlTower).toContain("className={styles.clientTitle}");
    expect(controlTower).toContain("className={styles.clientMeta}");
    expect(controlTower).toContain("className={styles.clientDots}");
    expect(controlTower).toContain("styles[signal.colour]");
    expect(controlTower).toContain('className="sr-only"');
    expect(controlTower).toContain('aria-hidden="true"');
    expect(controlTower).toContain("className={styles.clientFooter}");
    expect(controlTower).toContain('RED: "Over 48 hrs"');
    expect(controlTower).not.toContain('"--green"');
  });

  it("keeps the shared dark palette, square tabs, and semantic KPI rails explicit", () => {
    const globalCss = readFileSync(
      new URL("../../app/styles.css", import.meta.url),
      "utf8",
    );
    const primitives = readFileSync(
      new URL("../ui/primitives.tsx", import.meta.url),
      "utf8",
    );
    const controlTower = readFileSync(
      new URL("./control-tower.tsx", import.meta.url),
      "utf8",
    );
    const finalCascadeMarker = "/* Final UI-03 cascade";
    const finalCascadeIndex = globalCss.lastIndexOf(finalCascadeMarker);
    const finalCascade = globalCss.slice(finalCascadeIndex);

    expect(finalCascadeIndex).toBeGreaterThan(0);
    expect(globalCss.indexOf("@import url(")).toBe(0);
    expect(globalCss).toContain("family=Barlow+Condensed:wght@500;600;700");
    expect(globalCss).toContain("family=IBM+Plex+Mono:wght@400;500;600");
    expect(globalCss).toContain("family=IBM+Plex+Sans:wght@400;500;600");
    expect(globalCss).toContain("color-scheme: dark");
    expect(globalCss).toContain("--bg: #080d18");
    expect(globalCss).toContain("--surface: #0f1728");
    expect(globalCss).toContain("--surface-muted: #141e33");
    expect(globalCss).toContain("--line: #22304c");
    expect(globalCss).toContain("--ink: #e8eef9");
    expect(globalCss).toContain("--dim: #788daa");
    expect(globalCss).toContain(
      '--font-body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
    );
    expect(globalCss).toContain(
      '--font-display: "Barlow Condensed", "Oswald", Impact, sans-serif',
    );
    expect(finalCascade).toContain(".ui-metric-card::before");
    expect(finalCascade).toContain(".ui-tone-success");
    expect(finalCascade).toContain(".ui-tone-warning");
    expect(finalCascade).toContain(".ui-tone-danger");
    expect(finalCascade).toMatch(/\.ui-tabs\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(finalCascade).toMatch(
      /input,\s*\nselect,\s*\ntextarea,[\s\S]*?color: var\(--ink\);[\s\S]*?background: var\(--surface\);/,
    );
    expect(finalCascade).toMatch(
      /\.safe-json,[\s\S]*?color: var\(--ink\);[\s\S]*?background: rgb\(8 13 24 \/ 0\.72\);/,
    );
    expect(finalCascade).toMatch(
      /\.auth-page\s*\{[\s\S]*?var\(--bg\);[\s\S]*?\.auth-card\s*\{[\s\S]*?var\(--surface-muted\), var\(--surface\)/,
    );
    expect(finalCascade).toMatch(
      /\.success,[\s\S]*?color: #8be9ad;[\s\S]*?\.error,[\s\S]*?color: #ff9ca0;[\s\S]*?\.field-error\s*\{\s*color: #ff9ca0;/,
    );
    expect(finalCascade).toMatch(
      /\.form-feedback-popover\s*\{[\s\S]*?color: var\(--ink\);[\s\S]*?background: var\(--surface-raised\);/,
    );
    expect(primitives).toContain("ui-tone-${tone}");
    expect(controlTower).toContain("tone={kpiTone(key)}");
  });

  it("preserves dense Control Tower tables, vendor rails, and mobile card fallbacks", () => {
    const moduleCss = readFileSync(
      new URL("./control-tower.module.css", import.meta.url),
      "utf8",
    );

    expect(moduleCss).toContain("CTL-01 operations-console skin");
    expect(moduleCss).toContain(".vendor::before");
    expect(moduleCss).toMatch(
      /\.table th,\s*\n\.table td\s*\{[\s\S]*?0\.48rem/,
    );
    expect(moduleCss).toContain("font-family: var(--font-mono)");
    expect(moduleCss).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.recordCards\s*\{\s*display: grid;/,
    );
    expect(moduleCss).toMatch(
      /\.recordCards ~ \.tableWrap\s*\{\s*display: none;/,
    );
  });
});
