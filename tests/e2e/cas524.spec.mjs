// CAS-524: verifies the client-side half of universal-link deep-linking — when a native App.appUrlOpen
// event delivers a tapped universal-link URL (https://cascademovies.com/#/film/<id>), the app routes
// straight to that film's page via the SAME #/film/<id> hash route a share link/boot-time load already
// uses (openFilmPage/filmRouteId, CAS-... share-link work), not a second parallel "open a film" path.
//
// Capacitor.Plugins.App only has a browser fallback in Playwright/Chromium (no real native bridge) — see
// AppWeb in node_modules/@capacitor/app/dist/plugin.js, vendored verbatim as capacitor-app.js — so
// simulating the tap is a real notifyListeners() call through the same plugin proxy the app's own
// appUrlOpen listener is registered on, not a hand-rolled fake event.
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

test("CAS-524: a tapped universal link routes straight to the film page via the existing hash route", async ({ page }) => {
  await fakeNativePlatform(page);
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await gotoFresh(page);

  const id = await page.evaluate(() => MOVIES[0].tmdb_id);
  await page.evaluate((id) => {
    Capacitor.Plugins.App.notifyListeners("appUrlOpen", { url: `https://cascademovies.com/#/film/${id}` });
  }, id);

  await expect(page.locator("#filmPage.open")).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(`#/film/${id}`);
});

test("CAS-524: a universal link with no film hash is ignored, not routed", async ({ page }) => {
  await fakeNativePlatform(page);
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await gotoFresh(page);

  await page.evaluate(() => {
    Capacitor.Plugins.App.notifyListeners("appUrlOpen", { url: "https://cascademovies.com/" });
  });
  expect(await page.evaluate(() => location.hash)).toBe("");
  await expect(page.locator("#filmPage.open")).toHaveCount(0);
});

test("CAS-524: web build never wires the appUrlOpen listener, so a stray event is a no-op", async ({ page }) => {
  await freshApp(page);
  // capacitor-app.js loads unconditionally, same as CAS-463's push-notifications script — harmless
  // outside native since the listener itself is only registered when isNativePlatform() is true.
  await page.evaluate(() => {
    Capacitor.Plugins.App.notifyListeners("appUrlOpen", { url: "https://cascademovies.com/#/film/1" });
  });
  expect(await page.evaluate(() => location.hash)).toBe("");
});
