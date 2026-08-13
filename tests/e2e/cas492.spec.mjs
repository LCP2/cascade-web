// CAS-492: the CAS-486 fixture titles put "TEST FIXTURE — Notify …" first, so the card header's CSS
// truncation (~30 chars) always cuts the one word that actually identifies the fixture. Renamed so the
// discriminator ("TEST n") leads the title and survives truncation, with n matching the last digit of
// the reserved tmdb_id. This suite stays guest-mode/network-free (helpers.mjs), same approach as cas486's
// suite — it monkey-patches the fixtures gate rather than exercising a real Supabase sign-in.
import { test, expect } from "@playwright/test";

const FIXTURE_IDS = [999000001, 999000002, 999000003, 999000004, 999000005];

async function gotoWithFixturesFlag(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?fixtures=1");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?fixtures=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.evaluate((email) => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email };
  }, await page.evaluate(() => window.CascadeFixtures.FIXTURES_TEST_EMAILS[0]));
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
}

test("CAS-492: each fixture's title leads with TEST n, where n is the tmdb_id's last digit", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  const titles = await page.evaluate((ids) => MOVIES.filter(m => ids.includes(m.tmdb_id))
    .map(m => ({ tmdb_id: m.tmdb_id, title: m.title })), FIXTURE_IDS);

  expect(titles).toHaveLength(FIXTURE_IDS.length);
  for(const { tmdb_id, title } of titles){
    const lastDigit = String(tmdb_id).slice(-1);
    expect(title.startsWith(`TEST ${lastDigit} — `)).toBe(true);
  }
});

test("CAS-492: the TEST n discriminator is the first thing in the rendered card title, ahead of anything truncation would cut", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  const html = await page.evaluate((ids) => MOVIES.filter(m => ids.includes(m.tmdb_id))
    .map(m => cardHTML(m)), FIXTURE_IDS);

  for(let i = 0; i < FIXTURE_IDS.length; i++){
    const lastDigit = String(FIXTURE_IDS[i]).slice(-1);
    const m = html[i].match(/<span class="titletext">([^<]*)</);
    expect(m).not.toBeNull();
    expect(m[1].slice(0, 30)).toContain(`TEST ${lastDigit}`);
  }
});
