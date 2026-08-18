// CAS-568: header{position:sticky;z-index:30} is a stacking context, so the Menu dropdown's own
// z-index:95 (.navmenu) only orders it against the header's OTHER CHILDREN — it can never lift the
// dropdown above a sibling of the header. #agentsScreen and #yourMovies are the only two .uscreens that
// sit BELOW the header (top:var(--hdrh)) instead of covering it, so with either open the header itself —
// and its Menu — sat behind them at the header's own z-index:30 vs. their 84. Fix: drop those two screens
// to z-index:29, below the header, leaving the five screens that DO cover the header (Account, Lists,
// About, Review, Service analysis, all z-index:84) untouched.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toStreamListing(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
}

/** document.elementFromPoint() at the centre of a locator's own box, resolved to its closest match. */
async function elementAtCentreMatches(page, locator, closestSelector){
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  return page.evaluate(({ x, y, closestSelector }) => {
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest(closestSelector));
  }, { x, y, closestSelector });
}

test("CAS-568 (AC2): with Watch open, the Menu button opens a menu that is actually hit-testable", async ({ page }) => {
  await toStreamListing(page);

  await page.evaluate(() => window.openYourMovies());
  await expect(page.locator("#yourMovies.open")).toBeVisible();

  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#navMenu.open")).toBeVisible();

  expect(await elementAtCentreMatches(page, page.locator("#navMenu"), "#navMenu")).toBe(true);

  // AC4: a destination reached from over Watch actually opens, not swallowed by #yourMovies underneath.
  await page.locator("#navMenu .navitem", { hasText: "Languages" }).click();
  await expect(page.locator("#languagesScreen.open")).toBeVisible();
});

test("CAS-568 (AC3): with Manage Agents open, the Menu button opens a menu that is actually hit-testable", async ({ page }) => {
  await toStreamListing(page);

  await page.evaluate(() => window.openAgentsScreen());
  await expect(page.locator("#agentsScreen.open")).toBeVisible();

  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#navMenu.open")).toBeVisible();

  expect(await elementAtCentreMatches(page, page.locator("#navMenu"), "#navMenu")).toBe(true);
});

test("CAS-568 (AC5): Account, Lists, About, Review and Service analysis still cover the header completely", async ({ page }) => {
  await toStreamListing(page);
  const headerLoc = page.locator("header");

  const screens = [
    { open: () => page.evaluate(() => window.openAccount()), id: "#accountScreen" },
    { open: () => page.evaluate(() => window.openListsScreen()), id: "#listsScreen" },
    { open: () => page.evaluate(() => window.openAbout()), id: "#aboutScreen" },
    { open: () => page.evaluate(() => window.openReviewScreen(cascades[0].id)), id: "#reviewScreen" },
    { open: () => page.evaluate(() => window.openSvcAnalysis()), id: "#svcAnalysis" },
  ];

  for(const { open, id } of screens){
    await open();
    await expect(page.locator(`${id}.open`)).toBeVisible();
    expect(await elementAtCentreMatches(page, headerLoc, id)).toBe(true);
    await page.evaluate((sel) => document.querySelector(sel).classList.remove("open"), id);
  }
});
