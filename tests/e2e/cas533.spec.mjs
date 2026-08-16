// CAS-533: regression against CAS-530's nav — at real iPhone widths the two labelled mode chips + the
// menu icon never actually fit next to the CASCADE wordmark (both sides of .brandrow are flex:0 0 auto,
// so neither gives way — they just overlapped instead), and the "active" chip fill CAS-530 built was never
// visible because #agentsScreen/#yourMovies covered the header outright the moment either opened. Fixed by
// dropping the chip labels to icon-only below 460px, and by sitting those two screens below the header
// (top:var(--hdrh,0px)) instead of over it, same as .cascbar already sticks under it.
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

for(const width of [375, 390, 430]){
  test(`CAS-533: at ${width}px the CASCADE wordmark never collides with the nav chips`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await toStreamListing(page);

    const brand = await page.locator(".brandlockup").boundingBox();
    const actions = await page.locator(".hdr-actions").boundingBox();
    expect(brand.x + brand.width).toBeLessThanOrEqual(actions.x);

    // The wordmark itself has to still be on screen and legible, not just non-overlapping.
    await expect(page.locator(".brand")).toHaveText("Cascade");
    await expect(page.locator(".brand")).toBeVisible();
  });
}

test("CAS-533: Your Movies chip's rose fill is actually visible — the header stays on screen while its screen is open", async ({ page }) => {
  await toStreamListing(page);
  const movies = page.locator("#moviesBtn");

  await movies.click();
  await expect(page.locator("#yourMovies.open")).toBeVisible();
  await expect(page.locator("header")).toBeVisible();
  await expect(movies).toHaveClass(/active/);
  await expect(movies).toHaveCSS("background-image", /linear-gradient/);

  const headerBox = await page.locator("header").boundingBox();
  const screenBox = await page.locator("#yourMovies").boundingBox();
  expect(screenBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
});

// CAS-534 moved the Agents management/reorder screen off the header chip and into the top-right menu's
// "Manage Agents" entry — the chip's own gradient-fill-stays-visible behaviour is now covered against Your
// Movies below, and the management screen's own header-visibility is covered in cas534.spec.mjs.
test("CAS-534: Manage Agents (menu) gradient... — the header stays on screen while the management screen is open", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await expect(page.locator("header")).toBeVisible();

  const headerBox = await page.locator("header").boundingBox();
  const screenBox = await page.locator("#agentsScreen").boundingBox();
  expect(screenBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
});

test("CAS-534: opening Your Movies while Manage Agents is open switches screens instead of leaving both open", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies.open")).toBeVisible();
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);

  // The Agents chip closes Your Movies and returns to the deck+movie-list home view.
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#yourMovies")).not.toHaveClass(/open/);
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#moviesBtn")).not.toHaveClass(/active/);
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
});
