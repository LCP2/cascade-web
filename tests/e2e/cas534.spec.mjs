// CAS-534: nav IA correction — the header's Agents chip is a mode switch for the always-present deck+movie-
// list home view (the existing default landing screen), not a launcher for the separate Agents management/
// reorder screen. That management screen (drag-to-reorder, Edit per agent) still exists — it moved to a new
// "Manage Agents" entry in the top-right menu. Ship pairs with CAS-533's header-overlap/visibility fixes.
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

test("CAS-534: the Agents chip is lit by default — home (deck + movie list) is the default mode", async ({ page }) => {
  await toStreamListing(page);

  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
  await expect(page.locator("#moviesBtn")).not.toHaveClass(/active/);
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#yourMovies")).not.toHaveClass(/open/);
  await expect(page.locator("#cascStrip")).toBeVisible();
  await expect(page.locator("#groups")).toBeVisible();
});

test("CAS-534: clicking the Agents chip never opens the Agents management screen", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
});

test("CAS-534: the Agents chip closes Your Movies and returns to the home view", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies.open")).toBeVisible();
  await expect(page.locator("#agentsBtn")).not.toHaveClass(/active/);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#yourMovies")).not.toHaveClass(/open/);
  await expect(page.locator("#moviesBtn")).not.toHaveClass(/active/);
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
  await expect(page.locator("#cascStrip")).toBeVisible();
});

test("CAS-534: the top-right menu's Manage Agents entry opens the reorder screen, unchanged otherwise", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#navMenuBtn").click();
  const items = page.locator("#navMenu .navitem");
  await expect(items.nth(1)).toContainText("Manage Agents");

  await items.nth(1).click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#agentsScreen.open")).toBeVisible();
  await expect(page.locator("#agentsScreen .agrow")).toHaveCount(1);
  await expect(page.locator("#agentsScreen .agshdr .osh")).toHaveText("Agents");

  // The header chip stays lit the whole time — Manage Agents is a layer on top of home, not a different mode.
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
});

test("CAS-534: the Agents chip closes Manage Agents (opened from the menu) and returns to home", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen.open")).toBeVisible();

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
  await expect(page.locator("#cascStrip")).toBeVisible();
});

test("CAS-534: Manage Agents' own back button still works, same as before", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen.open")).toBeVisible();

  await page.locator("#agentsScreen .osback").click();
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
});
