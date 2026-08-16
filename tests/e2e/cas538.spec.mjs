// CAS-538: follow-up to CAS-533 — the header's brandmark icon (the small gradient mark next to the
// CASCADE wordmark) is dropped entirely, and the mode chips get their labels back below the 460px
// breakpoint using shorter strings ("Find"/"Watch" instead of "Agents"/"Your Movies") rather than going
// icon-only, since the freed-up width is now enough to fit them.
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

test("CAS-538: the header brandmark icon is gone, the CASCADE text wordmark stays", async ({ page }) => {
  await toStreamListing(page);

  await expect(page.locator("svg.brandmark")).toHaveCount(0);
  await expect(page.locator(".brand")).toHaveText("Cascade");
  await expect(page.locator(".brand")).toBeVisible();
});

for(const width of [375, 390, 430]){
  test(`CAS-538: at ${width}px the mode chips show "Find"/"Watch" labels, not icon-only`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await toStreamListing(page);

    const agents = page.locator("#agentsBtn");
    await expect(agents.locator(".mclabel-short")).toBeVisible();
    await expect(agents.locator(".mclabel-short")).toHaveText("Find");
    await expect(agents.locator(".mclabel-full")).toBeHidden();

    const movies = page.locator("#moviesBtn");
    await expect(movies.locator(".mclabel-short")).toBeVisible();
    await expect(movies.locator(".mclabel-short")).toHaveText("Watch");
    await expect(movies.locator(".mclabel-full")).toBeHidden();

    // Same non-overlap standard CAS-533 established: the wordmark and the chips never collide.
    const brand = await page.locator(".brandlockup").boundingBox();
    const actions = await page.locator(".hdr-actions").boundingBox();
    expect(brand.x + brand.width).toBeLessThanOrEqual(actions.x);

    // Nor with the freshness line beneath the wordmark.
    const updated = await page.locator(".updated").boundingBox();
    const chips = await page.locator("#agentsBtn").boundingBox();
    expect(updated.y + updated.height).toBeLessThanOrEqual(chips.y + chips.height + 1);
  });
}

test("CAS-538: above the breakpoint, the mode chips show the full \"Agents\"/\"Your Movies\" labels", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await toStreamListing(page);

  const agents = page.locator("#agentsBtn");
  await expect(agents.locator(".mclabel-full")).toBeVisible();
  await expect(agents.locator(".mclabel-full")).toHaveText("Agents");
  await expect(agents.locator(".mclabel-short")).toBeHidden();

  const movies = page.locator("#moviesBtn");
  await expect(movies.locator(".mclabel-full")).toBeVisible();
  await expect(movies.locator(".mclabel-full")).toHaveText("Your Movies");
  await expect(movies.locator(".mclabel-short")).toBeHidden();
});
