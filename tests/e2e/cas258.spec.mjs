// CAS-258: the splash strip names all five windows, split 2 / 3, with Upcoming in its own colour.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const rgb = s => s.replace(/\s/g, "");

test("CAS-258: all five windows are named, Purchase included", async ({ page }) => {
  await freshApp(page);
  const labels = await page.locator(".splashloz .splashpill").allTextContents();
  expect(labels.map(s => s.trim())).toEqual(["Upcoming", "In cinemas", "Purchase", "Rental", "Streaming"]);
});

test("CAS-258: two on the first line, three on the second, at every phone width", async ({ page }) => {
  for(const width of [360, 390, 430]){
    await page.setViewportSize({ width, height: 844 });
    await freshApp(page);
    const rows = page.locator(".splashloz .splashlozrow");
    await expect(rows).toHaveCount(2);

    const tops = await page.locator(".splashloz .splashpill").evaluateAll(
      els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    // Two distinct baselines, 2 pills then 3 — and nothing in row two crept up to row one.
    const line1 = tops.slice(0, 2), line2 = tops.slice(2);
    expect(new Set(line1).size, `row one broke at ${width}px`).toBe(1);
    expect(new Set(line2).size, `row two broke at ${width}px`).toBe(1);
    expect(line2[0], `the two rows collapsed into one at ${width}px`).toBeGreaterThan(line1[0]);
  }
});

test("CAS-258: Upcoming carries its own token, not the off-grey", async ({ page }) => {
  await freshApp(page);
  const dots = await page.locator(".splashloz .splashdot").evaluateAll(
    els => els.map(e => getComputedStyle(e).backgroundColor));
  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--upcoming").trim());

  expect(token, "--upcoming is not defined").toBeTruthy();
  expect(rgb(dots[0]), "Upcoming is still the grey that means 'off'").not.toBe("rgb(107,114,128)");
  // Every window is told apart from every other by hue.
  expect(new Set(dots.map(rgb)).size, "two windows share a colour").toBe(5);
});
