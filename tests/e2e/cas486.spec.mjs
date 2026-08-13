// CAS-486: the notify-test harness's fixture films are visible in the running app ONLY behind an
// explicit `?fixtures=1` URL flag AND a signed-in match on FIXTURES_TEST_EMAILS (CAS-489) — a leaked
// `?fixtures=1` URL, or the flag with no matching account, must show nothing. This suite stays
// guest-mode/network-free (helpers.mjs) so it cannot exercise a real Supabase sign-in; what it CAN
// verify without one is exactly the gate itself (both halves, independently) and the merge/render
// shape once both conditions are monkey-patched true, the same "reading, not simulating a Supabase
// round trip" approach cas487's suite uses for its own account-gated behaviour.
import { test, expect } from "@playwright/test";

const FIXTURE_IDS = [999000001, 999000002, 999000003, 999000004, 999000005];

async function gotoWithFixturesFlag(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?fixtures=1");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?fixtures=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
}

test("CAS-486: no ?fixtures=1 — the flag reads false and nothing is fetched or merged", async ({ page }) => {
  let fetched = false;
  await page.route("**/notify-films.json", route => { fetched = true; route.continue(); });
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  const requested = await page.evaluate(() => window.CascadeFixtures.fixturesRequested());
  expect(requested).toBe(false);
  const ids = await page.evaluate(() => MOVIES.map(m => m.tmdb_id));
  expect(ids.some(id => id >= 999000001 && id <= 999000999)).toBe(false);
  expect(fetched).toBe(false);
});

test("CAS-486: ?fixtures=1 with no matching account merges nothing — a leaked URL shows nothing", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  const requested = await page.evaluate(() => window.CascadeFixtures.fixturesRequested());
  expect(requested).toBe(true);   // the flag itself IS read...

  const before = await page.evaluate(() => MOVIES.length);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
  const after = await page.evaluate(() => MOVIES.length);
  expect(after).toBe(before);     // ...but guest mode (no account match) still merges nothing.
});

test("CAS-486: ?fixtures=1 AND the test account together merge the 5 fixture films, each visually marked", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  // Monkey-patch the one field the gate reads — no real Supabase round trip, matching the CAS-487
  // suite's own approach to an account-gated path.
  await page.evaluate((email) => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email };
  }, await page.evaluate(() => window.CascadeFixtures.FIXTURES_TEST_EMAILS[0]));

  const before = await page.evaluate(() => MOVIES.length);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
  const merged = await page.evaluate((ids) => MOVIES.filter(m => ids.includes(m.tmdb_id)).map(m => ({
    tmdb_id: m.tmdb_id, director: m.director, _fixture: m._fixture,
  })), FIXTURE_IDS);

  expect(merged).toHaveLength(FIXTURE_IDS.length);
  for(const m of merged){
    expect(m._fixture).toBe(true);
    expect(m.director).toBe("TEST FIXTURE — not a real title");
  }
  const after = await page.evaluate(() => MOVIES.length);
  expect(after).toBe(before + FIXTURE_IDS.length);
});

test("CAS-486: a merged fixture film renders the TEST badge on its card and film page", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  await page.evaluate((email) => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email };
  }, await page.evaluate(() => window.CascadeFixtures.FIXTURES_TEST_EMAILS[0]));
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());

  const html = await page.evaluate((id) => {
    const m = MOVIES.find(x => x.tmdb_id === id);
    return { card: cardHTML(m), page: filmPageHTML(m) };
  }, FIXTURE_IDS[0]);

  expect(html.card).toContain('class="fixturebadge"');
  expect(html.page).toContain('class="fixturebadge"');
  expect(html.page).toContain("TEST FIXTURE — not a real title");
});

test("CAS-486: a fetch failure degrades to no fixture films, not an error", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.route("**/tests/fixtures/notify-films.json", route => route.abort());
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err));

  await page.goto("/index.html?fixtures=1");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?fixtures=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.evaluate((email) => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email };
  }, await page.evaluate(() => window.CascadeFixtures.FIXTURES_TEST_EMAILS[0]));

  const before = await page.evaluate(() => MOVIES.length);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
  const after = await page.evaluate(() => MOVIES.length);

  expect(after).toBe(before);
  expect(pageErrors).toEqual([]);
});
