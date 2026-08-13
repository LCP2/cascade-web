// CAS-502: "the system should only notify where there is a Watch it alert" — an agent's own bell
// (alert_moments) no longer generates any delivery; only a film's own per-film Watch it tick does. This
// suite covers the front-end half of that: AC4, "no agent-level alert control remains in the UI that does
// not do anything."
//
// Two per-agent alert surfaces existed before this ticket:
//   1. The Cascade Builder modal's availability spine (buildSpine/.abell 📣 bells) — a PURE alert switch
//      with no other job. It notified nobody once the backend stopped reading alert_moments, so it is
//      removed outright here (not just disabled — a disabled dead switch is exactly what AC4 rules out).
//   2. The Edit Agent > Notifications screen's "Notify option" toggle (drawWatchLanes/#wwLanes) — this one
//      is NOT a pure alert switch: turning it on is also what keeps a "notify-only" window (e.g. Rent for a
//      Cinema agent) in the agent's WATCH scope, which still drives real, non-alert behaviour (found/new
//      counts). Removing it would risk silently narrowing what an agent tracks, so it is deliberately left
//      alone — flagged in the CAS-502 ticket comment as a scoping decision, not an oversight.
// alertLive() is the one function every "will this ever notify" promise in the app reads off (cards, the
// agent's own voice, the editor's paint) — it now always returns false, so this suite checks it directly
// rather than re-testing every caller.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-502: the Cascade Builder's per-window 📣 bell is gone — no dead alert switch remains", async ({ page }) => {
  await freshApp(page);

  await page.evaluate(() => { draft = {}; openEditor("Test"); openModal($("builder")); });
  await expect(page.locator("#cSpine .arow").first()).toBeVisible();

  const bells = await page.locator("#cSpine .abell").count();
  expect(bells).toBe(0);
  const why = await page.locator("#cSpine .awhy").count();
  expect(why).toBe(0);

  // The row's own scope toggle (.atog, which windows the agent watches/lists) is untouched — CAS-502 only
  // ever removed the ALERT control, never the listing/scope one.
  const rowCount = await page.evaluate(() => AVAIL_ROWS.length);
  await expect(page.locator("#cSpine .arow .atog")).toHaveCount(rowCount);
});

test("CAS-502: alertLive() never promises delivery, whatever an agent's own alerts say", async ({ page }) => {
  await freshApp(page);

  const result = await page.evaluate(() => {
    const c = { alerts: { cinema: true, past_opening: true, announced: true, opens_soon: true,
                           pvod: true, rental: true, included_streaming: true },
                status: [] };
    return {
      live: Object.keys(c.alerts).map(k => alertLive(c, k)),
      promise: alertPromise(c),
      summary: alertSummary(c),
    };
  });

  expect(result.live.every(v => v === false)).toBe(true);
  expect(result.promise).toContain("nothing will interrupt you");
  expect(result.promise).not.toContain("I'll tell you");
  expect(result.summary).toBe("alerts off");
});

test("CAS-502: the global 'Never alert me about' mute chips are untouched — they still do something real", async ({ page }) => {
  await freshApp(page);
  // Unlike the per-agent bell, this account-wide mute still has a live effect (CAS-103's notify_prefs.
  // excluded_moments now feeds match_film_watches' `excluded` param), so CAS-502 explicitly leaves it in
  // place — this is a regression guard that it wasn't collaterally removed along with the dead bell.
  const chipCount = await page.locator("#prefAlertChips .chip").count();
  expect(chipCount).toBeGreaterThan(0);
});
