// CAS-516: a signed-in account's `saveCascades()` is rewired (see the persistence IIFE) to sync to the
// account instead of writing localStorage, so the on-device cache (`cascade_cascades`) that a fresh boot
// paints from was never kept in step for an account-only device. A cold start after the app was
// backgrounded long enough for the OS to reclaim the webview then had nothing to show until loadAccount()'s
// network round trip returned — a 20+ second blank screen on a slow reconnect. The fix mirrors the
// authoritative list into that same cache (via the un-rewired saveCascadesLocal, so it never schedules a
// duplicate account sync) from both loadAccount() and reconcileCascades().
//
// This suite stays guest-mode/network-free (helpers.mjs) — it cannot exercise a real Supabase round trip.
// What it CAN verify without one: (1) the mechanism — loadAccount()/reconcileCascades() write the cache
// via a fake client, and (2) the payoff — a device that already has that cache renders its Cascades
// immediately on a fresh boot, with no account call in flight yet.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const FAKE_UID = "11111111-1111-4111-8111-111111111111";
const FAKE_CASCADE_ID = "22222222-2222-4222-8222-222222222222";

// Playwright serialises this via toString() and re-runs it inside the page — it cannot close over the
// module-level consts above, so uid/row travel in as the one argument instead.
function fakeSignedIn({ uid, row }){
  window.CascadeAuth = {
    enabled: true,
    session: { user: { id: uid } },
    client: {
      from(){
        return { select: async () => ({ data: [row], error: null }) };
      },
    },
  };
}

test("CAS-516: loadAccount() mirrors the account's Cascades into the cold-start cache", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splash")).toHaveClass(/open/);

  const row = { id: FAKE_CASCADE_ID, name: "Cached Agent", criteria: {}, active: true };
  await page.evaluate(fakeSignedIn, { uid: FAKE_UID, row });
  await page.evaluate(() => window.CascadePersistence.loadAccount());

  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_cascades") || "[]"));
  expect(cached).toHaveLength(1);
  expect(cached[0].id).toBe(FAKE_CASCADE_ID);
  expect(cached[0].name).toBe("Cached Agent");
});

test("CAS-516: reconcileCascades() keeps the cold-start cache in step on an ordinary background refresh", async ({ page }) => {
  await freshApp(page);

  const row = { id: FAKE_CASCADE_ID, name: "Reconciled Agent", criteria: {}, active: true };
  await page.evaluate(fakeSignedIn, { uid: FAKE_UID, row });
  await page.evaluate(() => window.CascadePersistence.reconcileCascades());

  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_cascades") || "[]"));
  expect(cached).toHaveLength(1);
  expect(cached[0].id).toBe(FAKE_CASCADE_ID);
  expect(cached[0].name).toBe("Reconciled Agent");
});

test("CAS-516: a device with a cached account Cascade shows it immediately on a fresh boot, before any account call", async ({ page }) => {
  await freshApp(page);

  // Simulate what the fix above leaves behind after a previous session: the cache seeded, onboarding
  // already completed (so this boot lands on the listing, not the first-run splash) — same as any
  // returning device.
  const row = { id: FAKE_CASCADE_ID, name: "Cold Start Agent", criteria: {}, active: true };
  await page.evaluate((r) => {
    localStorage.setItem("cascade_cascades", JSON.stringify([r]));
    localStorage.setItem("cascade_onboarded", "1");
  }, row);

  // A raw reload, not freshApp()/gotoFresh() — both clear storage, which is exactly what must NOT happen
  // here. config.js is already routed to a 404 from the freshApp() call above, and that route survives
  // this second navigation, so the boot still stays network-free.
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  const cascadesAtBoot = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name })));
  expect(cascadesAtBoot).toEqual([{ id: FAKE_CASCADE_ID, name: "Cold Start Agent" }]);
  await expect(page.locator(".dcard .dc-name", { hasText: "Cold Start Agent" })).toBeVisible();
});
