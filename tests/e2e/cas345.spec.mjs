// CAS-345: the account/about surfaces that used to be separate header icons (Account, Service analysis) or
// buried inside My streaming services (About) now live in one top-menu dropdown behind a single hamburger.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toListingWithAgent(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-345: the hamburger opens a menu directly beneath it, right-aligned under the icon", async ({ page }) => {
  await toListingWithAgent(page);
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  const btnBox = await page.locator("#navMenuBtn").boundingBox();
  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#navMenu")).toHaveClass(/open/);
  const menuBox = await page.locator("#navMenu").boundingBox();
  expect(menuBox.y).toBeGreaterThanOrEqual(btnBox.y + btnBox.height);
  expect(Math.round(menuBox.x + menuBox.width)).toBeCloseTo(Math.round(btnBox.x + btnBox.width), 0);
});

test("CAS-345: the menu lists Account, My services, Service analysis, About in that order", async ({ page }) => {
  await toListingWithAgent(page);
  await page.locator("#navMenuBtn").click();
  const items = await page.locator("#navMenu .navitem").allTextContents();
  expect(items).toEqual(["Account", "My services", "Service analysis", "About"]);
});

test("CAS-345: an outside tap dismisses the menu without picking anything", async ({ page }) => {
  await toListingWithAgent(page);
  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#navMenu")).toHaveClass(/open/);
  // The wordmark sits top-left of the header, clear of the anchored dropdown's top-right footprint —
  // #cascLbl is a full-width block and its own centre point sits underneath the open menu.
  await page.locator(".brand").click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#accountScreen")).not.toHaveClass(/open/);
});

test("CAS-345: Account opens the Account screen and closes the menu", async ({ page }) => {
  await toListingWithAgent(page);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#accountScreen")).toHaveClass(/open/);
});

test("CAS-345: My services opens the My streaming services modal", async ({ page }) => {
  await toListingWithAgent(page);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "My services" }).click();
  await expect(page.locator("#prefs")).toHaveClass(/open/);
});

test("CAS-345: Service analysis is the menu's permanent entry point to the CAS-344 page", async ({ page }) => {
  await toListingWithAgent(page);
  await expect(page.locator("#svcAnalysisBtn")).toHaveCount(0);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Service analysis" }).click();
  await expect(page.locator("#svcAnalysis")).toHaveClass(/open/);
  await expect(page.locator("#svcAnalysis .osh", { hasText: "Service analysis" })).toBeVisible();
});

test("CAS-345: About opens the CAS-346 About page", async ({ page }) => {
  await toListingWithAgent(page);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "About" }).click();
  await expect(page.locator("#aboutScreen")).toHaveClass(/open/);
  await expect(page.locator("#aboutScreen .osh", { hasText: "About" })).toBeVisible();
  await page.locator("#aboutScreen .osback").click();
  await expect(page.locator("#aboutScreen")).not.toHaveClass(/open/);
});
