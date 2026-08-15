// CAS-527: the installed iOS app has no capacitor.config.json server.url, so its WebView runs from a
// locally bundled www/ mirror with no live network origin — a relative fetch("movies.json") in pollCatalogue()
// (CAS-488) resolved against that empty bundle and silently no-op'd forever, freezing the installed app's
// catalogue to whatever was baked in at the last TestFlight/App Store build. CATALOGUE_URL now points a
// native build at the real production host; the web build keeps its same-origin relative fetch unchanged.
//
// The suite stays guest-mode/network-free (helpers.mjs). Capacitor.isNativePlatform() is monkey-patched by
// appending to the served capacitor-core.js — after it defines window.Capacitor, before the app's own inline
// script (which computes CATALOGUE_URL at top level) runs — so the app boots exactly as it would inside a
// real iOS WebView bridge, without faking the webkit bridge itself (which would also reroute plugin dispatch
// and risk unrelated push-registration paths this ticket doesn't touch).
import { test, expect } from "@playwright/test";
import { freshApp, gotoFresh } from "./helpers.mjs";

async function fakeNativePlatform(page){
  await page.route("**/capacitor-core.js", async route => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body: body + "\nif(typeof Capacitor!=='undefined'){Capacitor.isNativePlatform=()=>true;}",
    });
  });
}

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

test("CAS-527: web build keeps the same-origin relative catalogue URL", async ({ page }) => {
  await freshApp(page);
  const url = await page.evaluate(() => CATALOGUE_URL);
  expect(url).toBe("movies.json");
});

test("CAS-527: a native build points pollCatalogue at the absolute production URL and actually fetches it", async ({ page }) => {
  await fakeNativePlatform(page);
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await gotoFresh(page);

  const url = await page.evaluate(() => CATALOGUE_URL);
  expect(url).toBe("https://cascademovies.com/movies.json");

  const { id, title, payloadStr } = await buildChangedPayload(page, "2099-02-01");
  let hitAbsoluteUrl = false;
  await page.route("https://cascademovies.com/movies.json", route => {
    hitAbsoluteUrl = true;
    route.fulfill({
      status: 200, contentType: "application/json",
      headers: { etag: '"cas527-a"', "access-control-allow-origin": "*" },
      body: payloadStr,
    });
  });
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());

  const result = await page.evaluate((id) => MOVIES.find(m => m.tmdb_id === id)?.title, id);
  expect(hitAbsoluteUrl).toBe(true);
  expect(result).toBe(title);
});

test("CAS-527: a native build with a blocked catalogue fetch still degrades to the baked/last-known catalogue", async ({ page }) => {
  const pageErrors = [];
  await fakeNativePlatform(page);
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await gotoFresh(page);
  page.on("pageerror", err => pageErrors.push(err));

  const before = await page.evaluate(() => ({ len: MOVIES.length, today: TODAY }));
  await page.route("https://cascademovies.com/movies.json", route => route.abort());
  await page.evaluate(() => window.CascadePersistence.pollCatalogue());
  const after = await page.evaluate(() => ({ len: MOVIES.length, today: TODAY }));

  expect(after).toEqual(before);
  expect(pageErrors).toEqual([]);
});
