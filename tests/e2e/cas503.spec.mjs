// CAS-503: TODAY used to be a build-stamped constant (`__TODAY__`), so every window-status decision
// (primaryStatus, the RELEASING/RELEASED label, the Watch-it glow) stayed frozen at whatever the last build
// happened to say — even on a brand-new page load, and even while a tab stayed open across the real date it
// was frozen at. TODAY is now the device's own live local date (localToday(), app_template.html ~2990),
// re-evaluated on load and re-derived on every CAS-487 reconcile tick (advanceClock() inside pollCatalogue).
//
// This drives a REAL catalogue movie, not a ?fixtures=1 one — fixtures carry a hand-authored status/
// window_dates and deliberately skip deriveStatus() (see captureClaimedStatus/rederiveStatuses in
// app_template.html), so they would not exercise the exact mechanism this ticket fixes.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-503: TODAY is the device's live local date on first load, not a frozen build stamp", async ({ page }) => {
  await freshApp(page);
  const result = await page.evaluate(() => ({ today: TODAY, live: window.CascadePersistence.localToday() }));
  expect(result.today).toBe(result.live);
});

test("CAS-503: advancing the device's date past an upcoming film's cinema date flips it to In cinema, " +
     "flips RELEASING to RELEASED, and glows a ticked Watch-it control — no reload", async ({ page }) => {
  await freshApp(page);

  // The soonest real upcoming film in this build's catalogue, so a short forward jump crosses its cinema_date.
  const picked = await page.evaluate(() => {
    const candidates = MOVIES.filter(m => primaryStatus(m) === "upcoming" && m.cinema_date && m.cinema_date > TODAY);
    if(!candidates.length) return null;
    candidates.sort((a, b) => a.cinema_date.localeCompare(b.cinema_date));
    return { id: candidates[0].tmdb_id, cinema_date: candidates[0].cinema_date };
  });
  test.skip(picked === null, "no upcoming film with a future cinema_date in this build's catalogue");

  // Tick "In cinema" on the Watch-it control — an upcoming film's in_cinema rung isn't spent yet, so this is
  // exactly Lee's case: he asked to be told when the film reaches cinema, before it has.
  await page.evaluate((id) => window.toggleFilmOpt(id, "in_cinema"), picked.id);

  const before = await page.evaluate((id) => {
    const m = MOVIES.find(x => x.tmdb_id === id);
    return {
      primary: primaryStatus(m),
      released: bandHTML(m, "").includes('<span class="rellbl">Released</span>'),
      glowing: filmNotifyState(id).current,
    };
  }, picked.id);
  expect(before.primary).toBe("upcoming");
  expect(before.released).toBe(false);
  expect(before.glowing).toBe(false);

  // Move the device's clock to the day after the film's cinema date. Local Y/M/D components, deliberately not
  // an ISO/UTC string — the same local-calendar-date comparison the app itself now makes (CAS-503's whole
  // point), so this proves the fix against a real clock crossing, not a UTC one that could land a day off.
  const [y, mo, d] = picked.cinema_date.split("-").map(Number);
  await page.route("**/movies.json", route => route.abort());   // isolate this to the clock-only path
  await page.clock.install({ time: new Date(y, mo - 1, d + 1, 9, 0, 0) });

  // CAS-487's own reconcile entry point — exactly what a real focus/visibilitychange event fires, and the
  // "reuse the existing periodic-reconciliation mechanism" the ticket asks for. No page reload anywhere here.
  await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());

  const after = await page.evaluate((id) => {
    const m = MOVIES.find(x => x.tmdb_id === id);
    return {
      primary: primaryStatus(m),
      released: bandHTML(m, "").includes('<span class="rellbl">Released</span>'),
      glowing: filmNotifyState(id).current,
    };
  }, picked.id);

  expect(["in_cinema", "opening_week"]).toContain(after.primary);
  expect(after.released).toBe(true);
  expect(after.glowing).toBe(true);
});
