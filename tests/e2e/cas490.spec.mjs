// CAS-490: pollCatalogue() (CAS-488) used to replace MOVIES wholesale on every focus/visibilitychange/
// heartbeat refresh, silently wiping the CAS-486 ?fixtures=1 merge — a fixture film would vanish the
// moment the tab regained focus, and openFilmPage()/openNotifyFilm() on its id would then behave as if
// it were never in the catalogue. pollCatalogue() now re-applies maybeLoadFixtures() after every swap, so
// the merge survives a refresh instead of racing it. Same guest-mode/network-free approach as cas488/489.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const FIXTURE_ID = 999000005; // "TEST FIXTURE — Notify Hits Stream"

async function gotoWithFixturesFlag(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?fixtures=1");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?fixtures=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.evaluate(() => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email: "lee+c1@codynamics.com.au" };
  });
}

/** Clones the page's real MOVIES (fixtures excluded — this is what a real movies.json refresh serves)
 * so a poll's payload is schema-valid and carries none of the merged fixture rows. */
function freshCataloguePayload(page, etag){
  return page.evaluate((etag) => {
    const real = MOVIES.filter(m => !m._fixture).map(m => ({ ...m }));
    return { etag, body: JSON.stringify({ generated: TODAY, region: "AU", currency: "AUD", movies: real }) };
  }, etag);
}

test("CAS-490: a merged fixture film survives a pollCatalogue() refresh", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
  expect(await page.evaluate((id) => MOVIES.some(m => m.tmdb_id === id), FIXTURE_ID)).toBe(true);

  const { etag, body } = await freshCataloguePayload(page, '"cas490-a"');
  await page.route("**/movies.json", route => route.fulfill({
    status: 200, contentType: "application/json", headers: { etag }, body,
  }));
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());

  const stillThere = await page.evaluate((id) => MOVIES.find(m => m.tmdb_id === id), FIXTURE_ID);
  expect(stillThere).toBeTruthy();
  expect(stillThere._fixture).toBe(true);
});

test("CAS-490: openFilmPage() on a fixture id works after a catalogue refresh", async ({ page }) => {
  await gotoWithFixturesFlag(page);
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());

  const { etag, body } = await freshCataloguePayload(page, '"cas490-b"');
  await page.route("**/movies.json", route => route.fulfill({
    status: 200, contentType: "application/json", headers: { etag }, body,
  }));
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());

  await page.evaluate((id) => openFilmPage(id), FIXTURE_ID);
  const fpText = await page.locator("#filmPage").textContent();
  expect(fpText).not.toContain("Film not found");
  expect(fpText).toContain("TEST FIXTURE");
});

test("CAS-490: without the flag / for a non-gated account, no fixture is merged even after a refresh", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.route("**/notify-films.json", route => { throw new Error("must not fetch without ?fixtures=1"); });
  await freshApp(page);

  const before = await page.evaluate(() => MOVIES.length);
  const { etag, body } = await freshCataloguePayload(page, '"cas490-c"');
  await page.route("**/movies.json", route => route.fulfill({
    status: 200, contentType: "application/json", headers: { etag }, body,
  }));
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());

  const after = await page.evaluate(() => MOVIES.length);
  expect(after).toBe(before);
  expect(await page.evaluate((id) => MOVIES.some(m => m.tmdb_id === id), FIXTURE_ID)).toBe(false);
});
