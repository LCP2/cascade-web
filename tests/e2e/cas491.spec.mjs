// CAS-491: follow-on from CAS-490. Merging the fixtures (CAS-486) got a fixture film INTO MOVIES, but two
// independent gates still kept it off the listing under a gated account's DEFAULT settings — services
// scope ON, no new agent created:
//   1. The my-services scope filtered a fixture whose only offer is a service the tester doesn't happen to
//      subscribe to (Stan, here) straight out of the catalogue listing (passes()/matchesServices()).
//   2. A fixture's card-level offers list was filtered the same way, so even a card that DID render showed
//      an empty "where to watch" line for an offer it actually has.
// The fix exempts `_fixture` films from the services scope entirely (matchesServices, plus the card's own
// offers filter) — never from taste/criteria matching, which stays exactly what CAS-486 established. This
// suite verifies the exemption at the function level, the same "reading, not simulating a full UI flow"
// approach cas486/487/490's suites use for this account-gated harness.
import { test, expect } from "@playwright/test";

const FIXTURE_IDS = [999000001, 999000002, 999000003, 999000004, 999000005];
const STREAM_FIXTURE_ID = 999000005; // "TEST FIXTURE — Notify Hits Stream", offers: [{service: "Stan", type: "sub"}]

async function gotoAsGatedTester(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?fixtures=1");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?fixtures=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.evaluate((email) => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email };
  }, "lee+c1@codynamics.com.au");
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
}

/** Default settings for a gated tester per the ticket: services scope ON, subscribed to real AU services
 * that share NOTHING with the fixtures' offers (Stan, AppleTV) — exactly the "normal state" CAS-491
 * describes, and the case the old code failed under. Never touches cascades/agents. */
async function setDefaultGatedPrefs(page){
  await page.evaluate(() => {
    prefs.on = true; prefs.touched = true;
    prefs.sub = new Set(["Netflix", "Amazon Prime Video", "Disney Plus", "HBO Max"]);
    prefs.store = new Set();
    savePrefs();
  });
}

test("CAS-491: every fixture film passes the catalogue listing gate under default gated-account settings", async ({ page }) => {
  await gotoAsGatedTester(page);
  await setDefaultGatedPrefs(page);

  const results = await page.evaluate((ids) => ids.map(id => {
    const m = MOVIES.find(x => x.tmdb_id === id);
    return { id, passes: passes(m), matchesServices: matchesServices(m, primaryStatus(m)) };
  }), FIXTURE_IDS);

  for(const r of results){
    expect(r.matchesServices, `matchesServices(${r.id})`).toBe(true);
    expect(r.passes, `passes(${r.id})`).toBe(true);
  }
});

test("CAS-491: scopeRows() — the All listing's own row set — includes every fixture film", async ({ page }) => {
  await gotoAsGatedTester(page);
  await setDefaultGatedPrefs(page);

  const ids = await page.evaluate(() => scopeRows().map(m => m.tmdb_id));
  for(const id of FIXTURE_IDS) expect(ids).toContain(id);
});

test("CAS-491: the stream fixture's card keeps its own offer visible, not stripped by the services scope", async ({ page }) => {
  await gotoAsGatedTester(page);
  await setDefaultGatedPrefs(page);

  const html = await page.evaluate((id) => cardHTML(MOVIES.find(m => m.tmdb_id === id)), STREAM_FIXTURE_ID);
  expect(html).toContain("Stan");
});

test("CAS-491: the Watch it control is real and usable on a fixture with no agent behind it", async ({ page }) => {
  await gotoAsGatedTester(page);
  await setDefaultGatedPrefs(page);

  // No Cascade exists at all — the exact "no agent matches them" case the ticket describes — and the
  // control's own ladder (watchLevelsFor) has to offer rows anyway, since it is agent-independent (CAS-484).
  const levels = await page.evaluate((id) => watchLevelsFor(id).map(l => l.key), STREAM_FIXTURE_ID);
  expect(levels.length).toBeGreaterThan(0);

  const before = await page.evaluate((id) => !!((notify[id] || {}).wins || {}).stream, STREAM_FIXTURE_ID);
  expect(before).toBeFalsy();

  await page.evaluate((id) => window.toggleFilmOpt(id, "stream"), STREAM_FIXTURE_ID);

  const after = await page.evaluate((id) => notify[id].wins.stream, STREAM_FIXTURE_ID);
  expect(after).toBe(true);
});

test("CAS-491: no account-state change was needed — cascades and picked services are exactly what the test set", async ({ page }) => {
  await gotoAsGatedTester(page);
  await setDefaultGatedPrefs(page);

  const before = await page.evaluate(() => ({
    cascades: cascades.length,
    sub: [...prefs.sub].sort(),
  }));
  expect(before.cascades).toBe(0);

  await page.evaluate(() => scopeRows());   // the read path the listing itself takes

  const after = await page.evaluate(() => ({
    cascades: cascades.length,
    sub: [...prefs.sub].sort(),
  }));
  expect(after).toEqual(before);
});

test("CAS-491: the services-scope exemption is fixture-only — a real film still obeys the scope", async ({ page }) => {
  await gotoAsGatedTester(page);
  await setDefaultGatedPrefs(page);

  // A real streaming film whose only offer is a service the tester (per setDefaultGatedPrefs) does not
  // subscribe to must still be filtered out — the exemption must never leak onto genuine catalogue films.
  const result = await page.evaluate(() => {
    const m = MOVIES.find(x => !x._fixture && (x.offers || []).length
      && primaryStatus(x) === "included_streaming"
      && !(x.offers || []).some(o => o.service === "Netflix" || o.service === "Amazon Prime Video"
        || o.service === "Disney Plus" || o.service === "HBO Max"));
    if(!m) return null;
    return matchesServices(m, primaryStatus(m));
  });
  test.skip(result === null, "no real film in this catalogue build is scoped-out under the test's own prefs");
  if(result !== null) expect(result).toBe(false);
});
