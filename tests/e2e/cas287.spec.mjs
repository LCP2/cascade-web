// CAS-287: no confirmation toast fires while you are working a cascade.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

/** Record every toast raised from now on, however briefly. */
async function watchToasts(page){
  await page.evaluate(() => {
    window.__toasts = [];
    const orig = window.toast;
    window.toast = m => { window.__toasts.push(m); return orig(m); };
  });
}
const toasts = page => page.evaluate(() => window.__toasts);

async function toAgentListing(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-287: answering a film raises no toast", async ({ page }) => {
  await toAgentListing(page);
  await watchToasts(page);
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(1).click();
  await settleListing(page);
  expect(await toasts(page), "the most repeated gesture in the app must not interrupt").toEqual([]);
});

test("CAS-287: answering several in a row raises none", async ({ page }) => {
  await toAgentListing(page);
  await watchToasts(page);
  for(let i = 0; i < 3; i++){
    const card = page.locator("#groups .card").first();
    if(await card.count() === 0) break;
    await card.scrollIntoViewIfNeeded();
    await card.locator(".ctl.watch").click();
    await card.locator(".cpop .cseg").nth(0).click();
    await settleListing(page);
  }
  expect(await toasts(page)).toEqual([]);
});

test("CAS-287: switching cascades raises no toast", async ({ page }) => {
  await toAgentListing(page);
  await watchToasts(page);
  await page.evaluate(() => deckGo(0, false));
  await page.locator(".dcard.all").first().click();
  await settleListing(page);
  expect(await toasts(page)).toEqual([]);
});

test("CAS-287: moving a film to another cascade raises no toast", async ({ page }) => {
  await toAgentListing(page);
  await page.evaluate(() => {
    const src = activeCascade();
    cascades.push(normCascade({ ...src, id: cascadeNewId(), name: "Second Cascade", icon: "🎬" }));
    saveCascades(); render();
  });
  await settleListing(page);
  await watchToasts(page);
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  await card.locator(".ctl.casc").click();
  await card.locator(".cpop.kpop .nopt[data-cid]").first().click();
  await settleListing(page);
  expect(await toasts(page)).toEqual([]);
});

test("CAS-287: arriving at the listing raises no greeting", async ({ page }) => {
  await toAgentListing(page);
  // Reload as a returning visitor — this is where "Welcome back" and "found N since you last looked" fired.
  await page.addInitScript(() => {
    window.__toasts = [];
    const iv = setInterval(() => {
      if(typeof window.toast === "function"){
        clearInterval(iv);
        const orig = window.toast;
        window.toast = m => { window.__toasts.push(m); return orig(m); };
      }
    }, 0);
  });
  await page.reload();
  await settleListing(page);
  await page.waitForTimeout(500);
  const seen = (await page.evaluate(() => window.__toasts || [])).join(" | ");
  expect(seen).not.toMatch(/Welcome back/i);
  expect(seen).not.toMatch(/since you last looked/i);
});

// The ticket is about CONFIRMATIONS. Things that are the only way to learn something, or that report a
// failure, are a different class and are deliberately kept — a silent error is worse than an interruption.
test("CAS-287: the explainers survive, because a toast is the only way to read them", async ({ page }) => {
  await toAgentListing(page);
  expect(await page.evaluate(() => typeof window.showScale)).toBe("function");
  expect(await page.evaluate(() => typeof window.showImdbWhy)).toBe("function");
  await watchToasts(page);
  const withBadge = await page.evaluate(() => {
    const b = document.querySelector("#groups .tentbadge");
    if(!b) return false;
    b.click();
    return true;
  });
  test.skip(!withBadge, "no scale badge on screen today");
  expect((await toasts(page)).length, "the scale explainer must still speak").toBeGreaterThan(0);
});

test("CAS-287: an unasked-for change to your saved cascades still says so", async ({ page }) => {
  await toAgentListing(page);
  // The duplicate clean-up edits the user's deck on their behalf at boot. That is not a confirmation of
  // anything they did, so it keeps its voice.
  const src = await page.evaluate(() => document.documentElement.outerHTML.includes("Cleaned up"));
  expect(src, "the app must announce edits it made to your saved work without being asked").toBe(true);
});
