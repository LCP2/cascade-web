// CAS-488: index.html ships MOVIES/BUILD_DATE baked at build time so first paint needs no network, but a tab
// left open never used to see a new film, a status change, or a recalculated glow. pollCatalogue() now
// fetches movies.json (same origin, already served next to index.html) on the same focus/visibilitychange/
// heartbeat triggers CAS-487 wired up for the bell, swaps MOVIES/BUILD_DATE in, and repaints — unless
// something is mid-interaction (an open modal/drawer/popup), in which case the data still updates but the
// repaint is deferred rather than yanking the UI out from under the user. CAS-503: TODAY is a separate,
// always-live concept now — see cas503.spec.mjs.
//
// The suite stays guest-mode/network-free (helpers.mjs) and never talks to the real movies.json — every
// test here drives pollCatalogue() against a mocked response via page.route, so it is deterministic and
// fast regardless of the real catalogue's ~11MB size or its actual freshness on the day the suite runs.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

/** Clones the page's real MOVIES (so the schema is always valid), retitles movies[0], and returns both the
 * JSON string to serve and the id/title to assert on. */
async function buildChangedPayload(page, generated){
  return page.evaluate((generated) => {
    const clone = MOVIES.map(m => ({ ...m }));
    clone[0] = { ...clone[0], title: clone[0].title + " (LIVE UPDATE)" };
    return {
      id: clone[0].tmdb_id,
      title: clone[0].title,
      payloadStr: JSON.stringify({ generated, region: "AU", currency: "AUD", live: true, movies: clone }),
    };
  }, generated);
}

test("CAS-488: a blocked/failed movies.json poll leaves the baked catalogue and TODAY untouched", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err));
  await freshApp(page);

  const before = await page.evaluate(() => ({ len: MOVIES.length, today: TODAY }));
  await page.route("**/movies.json", route => route.abort());
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());
  const after = await page.evaluate(() => ({ len: MOVIES.length, today: TODAY }));

  expect(after).toEqual(before);
  expect(pageErrors).toEqual([]);
});

// CAS-503: TODAY no longer tracks the catalogue's own build stamp — it is always the device's live local
// date (advanceClock(), checked unconditionally at the top of every pollCatalogue() run). What a fresh
// catalogue now moves is BUILD_DATE, the "Updated <date>" label's own source.
test("CAS-503: a changed catalogue replaces MOVIES/BUILD_DATE and repaints when nothing is open, but TODAY stays the device's own date", async ({ page }) => {
  await freshApp(page);
  const { id, title, payloadStr } = await buildChangedPayload(page, "2099-01-01");

  await page.route("**/movies.json", route => route.fulfill({
    status: 200, contentType: "application/json", headers: { etag: '"cas488-a"' }, body: payloadStr,
  }));
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());

  const result = await page.evaluate((id) => ({
    title: MOVIES.find(m => m.tmdb_id === id)?.title,
    buildDate: BUILD_DATE,
    today: TODAY,
    updatedLabel: document.getElementById("updated").textContent,
  }), id);

  expect(result.title).toBe(title);
  expect(result.buildDate).toBe("2099-01-01");
  expect(result.today).toBe(await page.evaluate(() => window.CascadePersistence.localToday()));
  expect(result.updatedLabel).toContain("Updated");
});

test("CAS-488: a repeat poll with the same ETag never re-parses the body, even if it changed server-side", async ({ page }) => {
  await freshApp(page);
  const first = await buildChangedPayload(page, "2099-01-02");
  let requestNo = 0;
  await page.route("**/movies.json", route => {
    requestNo++;
    // Every response after the first carries a DIFFERENT (corrupted) title but the SAME etag — if the fix's
    // etag short-circuit ever regressed to always parsing, this second poll would pick it up.
    const body = requestNo === 1
      ? first.payloadStr
      : first.payloadStr.replace("(LIVE UPDATE)", "(SHOULD NEVER BE SEEN)");
    route.fulfill({ status: 200, contentType: "application/json", headers: { etag: '"cas488-b"' }, body });
  });

  await page.evaluate(() => window.CascadePersistence.pollCatalogue());
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());

  const title = await page.evaluate((id) => MOVIES.find(m => m.tmdb_id === id)?.title, first.id);
  expect(requestNo).toBe(2);          // both polls actually hit the network...
  expect(title).toBe(first.title);    // ...but the second's body was never parsed, so the corruption never landed
});

test("CAS-488: a poll landing while something is open updates the data but defers the repaint", async ({ page }) => {
  await freshApp(page);
  const { id, title, payloadStr } = await buildChangedPayload(page, "2099-01-03");

  // Every modal/screen/onboarding-step/filmpage in this app sets exactly this while open (openModal and its
  // siblings all share the convention) — setting it directly exercises catalogueUIBusy()'s real signal
  // without needing to drive a specific overlay's own open flow.
  await page.evaluate(() => { document.body.style.overflow = "hidden"; });

  await page.route("**/movies.json", route => route.fulfill({
    status: 200, contentType: "application/json", headers: { etag: '"cas488-c"' }, body: payloadStr,
  }));
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());

  const result = await page.evaluate((id) => ({
    busyStillSet: document.body.style.overflow,
    title: MOVIES.find(m => m.tmdb_id === id)?.title,   // the data update is NOT deferred — only the repaint is
  }), id);

  expect(result.busyStillSet).toBe("hidden");   // nothing closed the overlay out from under itself
  expect(result.title).toBe(title);             // but the catalogue is already live, ready for the next quiet poll
});
