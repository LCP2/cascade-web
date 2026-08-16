// CAS-530: top nav icon refresh — Agents gets the radar glyph, Your Movies gets the bookmark glyph, both
// render as wider labelled chips (not bare icon squares), and the active screen's chip is highlighted (rose
// fill for Your Movies, per CAS-529's accent). The bell is gone from the bar entirely — Notifications moves
// into the existing right-hand Menu as a new top entry.
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

test("CAS-530: the bell is gone from the header bar, and Notifications is the Menu's top entry instead", async ({ page }) => {
  await toStreamListing(page);

  await expect(page.locator("#bell")).toHaveCount(0);
  await expect(page.locator(".hdr-actions #agentsBtn, .hdr-actions #moviesBtn, .hdr-actions #navMenuBtn")).toHaveCount(3);

  await page.locator("#navMenuBtn").click();
  const items = page.locator("#navMenu .navitem");
  await expect(items.first()).toContainText("Notifications");

  // The unread badge that used to sit on the bell now rides along on the Menu entry.
  await expect(page.locator("#navMenu .navitem #badge")).toHaveCount(1);
});

test("CAS-530: Notifications opens the same drawer the old bell did", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Notifications" }).click();

  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#drawer")).toHaveClass(/open/, { timeout: 5_000 });
});

test("CAS-530: Agents and Your Movies render as wider labelled chips, each with its own icon", async ({ page }) => {
  await toStreamListing(page);

  const agents = page.locator("#agentsBtn");
  await expect(agents).toHaveClass(/modechip/);
  await expect(agents.locator(".mclabel-full")).toHaveText("Agents");
  await expect(agents.locator("svg")).toHaveCount(1);

  const movies = page.locator("#moviesBtn");
  await expect(movies).toHaveClass(/modechip/);
  await expect(movies.locator(".mclabel-full")).toHaveText("Your Movies");
  await expect(movies.locator("svg")).toHaveCount(1);
});

test("CAS-530: Your Movies chip lights up rose while its screen is open, and clears on close", async ({ page }) => {
  await toStreamListing(page);
  const movies = page.locator("#moviesBtn");

  await expect(movies).not.toHaveClass(/active/);
  await movies.click();
  await expect(page.locator("#yourMovies.open")).toBeVisible();
  await expect(movies).toHaveClass(/active/);
  await expect(movies).toHaveClass(/ym/);   // the rose treatment is scoped to .modechip.ym.active
  await expect(movies).toHaveAttribute("aria-expanded", "true");

  await page.locator("#yourMovies .osback").click();
  await expect(page.locator("#yourMovies.open")).toHaveCount(0);
  await expect(movies).not.toHaveClass(/active/);
  await expect(movies).toHaveAttribute("aria-expanded", "false");
});

// CAS-534 retargeted the Agents chip from "opens the Agents management screen" to "shows the deck+movie-list
// home view" — it keeps its brand-gradient fill (still not the rose ".ym" treatment), just lit by default
// instead of on click. See cas534.spec.mjs for the chip's current behaviour.
test("CAS-534: Agents chip keeps its brand-gradient active state, lit by default for the home view", async ({ page }) => {
  await toStreamListing(page);
  const agents = page.locator("#agentsBtn");

  await expect(agents).toHaveClass(/active/);
  await expect(agents).not.toHaveClass(/ym/);   // Agents never gets Your Movies' rose treatment
});
