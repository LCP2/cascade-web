// CAS-489: the ?fixtures=1 gate checks membership in FIXTURES_TEST_EMAILS, an allow-list, not a
// single constant — so the real test account (lee+c1@codynamics.com.au) and the original account
// (lee@codynamics.com.au) both pass, and any third account still fails closed. Same guest-mode/
// network-free, monkey-patch-the-gate approach as the cas486 suite this extends.
import { test, expect } from "@playwright/test";

const FIXTURE_IDS = [999000001, 999000002, 999000003, 999000004, 999000005];

async function gotoWithFixturesFlag(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?fixtures=1");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?fixtures=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
}

test("CAS-489: FIXTURES_TEST_EMAILS is the lee+c1 / lee allow-list", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  const emails = await page.evaluate(() => window.CascadeFixtures.FIXTURES_TEST_EMAILS);
  expect(emails).toContain("lee+c1@codynamics.com.au");
  expect(emails).toContain("lee@codynamics.com.au");
});

test("CAS-489: lee+c1@codynamics.com.au on ?fixtures=1 merges the 5 fixture films with the badge", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  await page.evaluate(() => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email: "lee+c1@codynamics.com.au" };
  });

  const before = await page.evaluate(() => MOVIES.length);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
  const merged = await page.evaluate((ids) => MOVIES.filter(m => ids.includes(m.tmdb_id)).map(m => ({
    tmdb_id: m.tmdb_id, _fixture: m._fixture,
  })), FIXTURE_IDS);
  const after = await page.evaluate(() => MOVIES.length);

  expect(merged).toHaveLength(FIXTURE_IDS.length);
  for(const m of merged) expect(m._fixture).toBe(true);
  expect(after).toBe(before + FIXTURE_IDS.length);

  const html = await page.evaluate((id) => cardHTML(MOVIES.find(x => x.tmdb_id === id)), FIXTURE_IDS[0]);
  expect(html).toContain('class="fixturebadge"');
});

test("CAS-489: lee+c1@codynamics.com.au without ?fixtures=1 merges nothing", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.route("**/notify-films.json", route => { throw new Error("must not fetch without ?fixtures=1"); });
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.evaluate(() => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email: "lee+c1@codynamics.com.au" };
  });

  const before = await page.evaluate(() => MOVIES.length);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
  const after = await page.evaluate(() => MOVIES.length);
  expect(after).toBe(before);
});

test("CAS-489: an account not on the allow-list merges nothing even with ?fixtures=1", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  await page.evaluate(() => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email: "someone-else@codynamics.com.au" };
  });

  const before = await page.evaluate(() => MOVIES.length);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
  const after = await page.evaluate(() => MOVIES.length);
  expect(after).toBe(before);
});

test("CAS-489: unflagged production boot performs zero extra runtime fetches", async ({ page }) => {
  let fetched = false;
  await page.route("**/notify-films.json", route => { fetched = true; route.continue(); });
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  expect(fetched).toBe(false);
});
