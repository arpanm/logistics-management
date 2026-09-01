import { expect, type Locator, type Page } from "@playwright/test";

const focusable =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export async function expectDocumentContained(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const root = document.documentElement;
          return Math.max(0, root.scrollWidth - root.clientWidth);
        }),
      { message: "the document must not create horizontal page scrolling" },
    )
    .toBeLessThanOrEqual(1);
}

export async function expectResponsiveDialogLayout(
  page: Page,
  dialog: Locator,
  expectedColumns: 1 | 2,
) {
  await expect(dialog).toBeVisible();
  const grid = dialog.locator(".ui-form-grid").first();
  await expect(grid).toBeVisible();
  const columns = await grid.evaluate(
    (node) =>
      getComputedStyle(node)
        .gridTemplateColumns.split(" ")
        .filter((value) => Number.parseFloat(value) > 0).length,
  );
  expect(columns).toBe(expectedColumns);

  const body = dialog.locator(".ui-dialog-body");
  const actions = dialog.locator(".ui-dialog-actions");
  await expect(body).toBeVisible();
  await expect(actions).toBeVisible();
  const [bodyBox, actionBox] = await Promise.all([
    body.boundingBox(),
    actions.boundingBox(),
  ]);
  expect(bodyBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(bodyBox!.y + bodyBox!.height).toBeLessThanOrEqual(actionBox!.y + 1);
  await expectDocumentContained(page);
}

export async function applyTextResize(page: Page, percent = 200) {
  await page.evaluate((value) => {
    document.documentElement.style.fontSize = `${value}%`;
  }, percent);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      ),
    )
    .toBeGreaterThanOrEqual(31);
}

export async function expectMobileRecords(page: Page, label: string) {
  const records = page.getByLabel(label).filter({ visible: true }).first();
  await expect(records).toBeVisible();
  await expect(records.locator("article").first()).toBeVisible();
  await expectDocumentContained(page);
}

export async function expectContainedModal(
  page: Page,
  trigger: Locator,
  dialog: Locator = page.getByRole("dialog"),
) {
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  await expect
    .poll(() =>
      dialog.evaluate((node) => node.contains(document.activeElement)),
    )
    .toBe(true);
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds, "the visible dialog has measurable geometry").not.toBeNull();
  expect(viewport, "the responsive project supplies a viewport").not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height + 1);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");

  const controls = dialog.locator(focusable).filter({ visible: true });
  await expect(controls.first()).toBeVisible();
  await controls.last().focus();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectDocumentContained(page);
}
