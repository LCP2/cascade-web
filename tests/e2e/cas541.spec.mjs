// CAS-541: the Watch List card's Edit panel (CAS-535) used to be dismissible only by re-tapping "Edit"
// itself — nothing else in the app closed it. Every other popover (the deck's own Watch it filter panel,
// closeFilterPanel) closes on an outside tap, Escape, or scroll; this brings the Edit panel in line with
// that convention.
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

function openYourMovies(page){ return page.evaluate(() => window.openYourMovies()); }

async function openEditPanel(page){
  const card = page.locator(".ymcard");
  await card.locator(".ymcedit").click();
  await expect(page.locator(".ympanel")).toBeVisible();
  await expect(card.locator(".ymcedit")).toHaveClass(/on/);
}

test("CAS-541: an outside tap closes the open Edit panel", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);
  await openEditPanel(page);

  await page.locator("#ymResultBar").click();   // well outside the panel/Edit button

  await expect(page.locator(".ympanel")).toHaveCount(0);
  await expect(page.locator(".ymcard .ymcedit")).not.toHaveClass(/on/);
});

test("CAS-541: a tap inside the panel does not close it", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);
  await openEditPanel(page);

  await page.locator(".ympanel .ymphead").first().click();

  await expect(page.locator(".ympanel")).toBeVisible();
});

test("CAS-541: Escape closes the open Edit panel", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);
  await openEditPanel(page);

  await page.keyboard.press("Escape");

  await expect(page.locator(".ympanel")).toHaveCount(0);
  await expect(page.locator(".ymcard .ymcedit")).not.toHaveClass(/on/);
});

test("CAS-541: scrolling the page closes the open Edit panel", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);
  await openEditPanel(page);

  await page.evaluate(() => window.scrollTo(0, 300));

  await expect(page.locator(".ympanel")).toHaveCount(0);
  await expect(page.locator(".ymcard .ymcedit")).not.toHaveClass(/on/);
});
