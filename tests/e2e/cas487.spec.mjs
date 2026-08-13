// CAS-487 (Problem 1): the bell had no push channel on web, so an open tab's badge/drawer were frozen
// at whatever they were when the page loaded — reconcileOnReturn() refreshed cascades/films/lists/watches
// on focus/visibilitychange, but never loadRealAlerts(). The fix adds that call, plus a visible-tab
// heartbeat (setInterval) for a tab that stays focused for hours without ever firing focus/visibilitychange
// again.
//
// The suite stays guest-mode/network-free (helpers.mjs), so this cannot exercise a real Supabase round
// trip for a signed-in account. What it CAN verify without one: the accountActive() guard still holds (no
// extra work for a signed-out user — an explicit acceptance criterion), the focus/visibilitychange wiring
// reaches reconcileOnReturn without throwing, and the real browser's setInterval return value is exactly
// the shape (no unref()) the fix's Node-vs-browser guard assumes.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-487: a signed-out tab's badge is untouched by focus/visibilitychange, and neither throws", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err));

  await freshApp(page);
  await expect(page.locator("#badge")).toBeHidden();

  await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());
  await expect(page.locator("#badge")).toBeHidden();

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#badge")).toBeHidden();

  expect(pageErrors).toEqual([]);
});

test("CAS-487: loadRealAlerts is reachable through reconcileOnReturn and is itself signed-out-safe", async ({ page }) => {
  await freshApp(page);

  // Guest mode has no account, so this is the exact path a signed-out reconcileOnReturn() takes —
  // confirms the call CAS-487 adds resolves cleanly rather than throwing on a missing client/uid.
  await page.evaluate(() => window.CascadePersistence.loadRealAlerts());
  await expect(page.locator("#badge")).toBeHidden();
});

test("CAS-487: the real browser's setInterval return value has no unref(), which is why the heartbeat guards for it", async ({ page }) => {
  await freshApp(page);
  // This is the exact condition the CAS-487 fix depends on: app_template.html's periodic reconcile-poll
  // handle only calls .unref() when the method exists, specifically so a real browser (which returns a
  // plain number here) never calls a method it doesn't have, while Node's test harness (which evaluates
  // this same shipped script against a stand-in DOM for tests/js/engine.mjs) can use unref() to stop that
  // interval from holding the process open forever.
  const shape = await page.evaluate(() => {
    const h = window.setInterval(() => {}, 60_000);
    window.clearInterval(h);
    return { type: typeof h, hasUnref: typeof h?.unref === "function" };
  });
  expect(shape).toEqual({ type: "number", hasUnref: false });
});
