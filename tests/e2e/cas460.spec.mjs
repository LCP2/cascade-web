// CAS-460: additive-only diagnostic instrumentation so a real iOS device's Safari Web Inspector console
// can show the actual timing breakdown of boot/sign-in — no behaviour change, just [CAS-460]-prefixed
// console.log(performance.now()) markers around: session restore, the account-data fan-out,
// pollCatalogue()'s fetch, and recomputeFound(). This spec only proves the markers fire and the app still
// behaves exactly as before; it can't produce the real-device timing data the ticket ultimately needs.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-460: boot logs matched start/end timing markers for session restore and recomputeFound", async ({ page }) => {
  const lines = [];
  page.on("console", msg => {
    const text = msg.text();
    if(text.startsWith("[CAS-460]")) lines.push(text);
  });

  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();

  const starts = lines.filter(l => l.includes(" start"));
  const ends = lines.filter(l => l.includes(" end"));
  expect(starts.length).toBeGreaterThan(0);
  expect(ends.length).toBeGreaterThan(0);
  expect(ends.length).toBe(starts.length);

  // freshApp() 404s config.js, so guest boot never reaches the Supabase auth module (session restore only
  // fires when Supabase is configured) — but render() always calls recomputeFound() on every paint,
  // including the very first one, so that pair is the one guaranteed marker on this path.
  expect(lines.some(l => l.startsWith("[CAS-460] recomputeFound start"))).toBe(true);
  expect(lines.some(l => l.startsWith("[CAS-460] recomputeFound end"))).toBe(true);
});

test("CAS-460: instrumentation is additive-only — guest boot behaves exactly as before", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splash")).toHaveClass(/open/);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  expect(await page.evaluate(() => Array.isArray(MOVIES) && MOVIES.length > 0)).toBe(true);
});
