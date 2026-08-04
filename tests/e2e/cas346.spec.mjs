// CAS-346: the build-provenance stamp (version/build/commit/env/builtAt) moves off the My streaming
// services modal onto its own About page (the CAS-345 top-menu route). #aboutBuild is created fresh each
// time the About page renders — unlike the footer's #buildStamp, which is stamped once at load — so this
// checks it is populated live, not just present in markup.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toListingWithAgent(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-346: the About page shows the build stamp, matching the footer's build info", async ({ page }) => {
  await toListingWithAgent(page);
  await page.evaluate(() => window.openAbout());
  await expect(page.locator("#aboutScreen")).toHaveClass(/open/);
  const aboutText = await page.locator("#aboutBuild").textContent();
  expect(aboutText).toMatch(/^v\d+\.\d+\.\d+ · build \S+ · \S+ · env: (staging|production)/);
  const footText = await page.locator("#buildStamp").textContent();
  expect(footText.startsWith(aboutText.split(" · env:")[0])).toBe(true);
});

test("CAS-346: the build stamp is gone from My streaming services", async ({ page }) => {
  await toListingWithAgent(page);
  await page.evaluate(() => window.openPrefs());
  await expect(page.locator("#prefs")).toHaveClass(/open/);
  await expect(page.locator("#prefs #aboutBuild")).toHaveCount(0);
  await expect(page.locator("#prefs .flabel", { hasText: /^About$/ })).toHaveCount(0);
});
