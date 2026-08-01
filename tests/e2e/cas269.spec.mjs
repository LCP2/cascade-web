// CAS-269: the header carries what changes, not what never does.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-269: the AU chip and the 'Live AU data' line are gone", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("header .region")).toHaveCount(0);
  await expect(page.locator("header")).not.toContainText(/Live AU data/);
  await expect(page.locator("header")).not.toContainText(/📍/);
});

test("CAS-269: the freshness date survives, and is a real date", async ({ page }) => {
  await freshApp(page);
  const updated = page.locator("#updated");
  await expect(updated).toBeVisible();
  const text = (await updated.textContent()).trim();
  expect(text, `the freshness line reads "${text}"`).toMatch(/^Updated \S/);
  expect(text).not.toMatch(/Live AU data/);
  // It is the build's own date, not a hardcoded string.
  const today = await page.evaluate(() => fmtDate(TODAY));
  expect(text).toContain(today);
});

test("CAS-269: the header row still fits on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await freshApp(page);
  const spill = await page.evaluate(() => {
    const h = document.querySelector("header").getBoundingClientRect();
    return [...document.querySelectorAll("header .iconbtn")]
      .filter(e => e.getBoundingClientRect().right > h.right + 1).length;
  });
  expect(spill, "header controls are past the right edge").toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
