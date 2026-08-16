// CAS-539: Your Movies drops its own back arrow and "Your Movies" page title/subtitle — the header's
// Agents/Your Movies mode chips (CAS-534) already handle navigation, and the Watch List card's own title
// ("Watch List") already says what the screen is. The Watch List card (CAS-535) becomes the first thing
// in the screen body, directly under the persistent header.
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

test("CAS-539: Your Movies has no back arrow or page title/subtitle, and the Watch List card is the first thing in the body", async ({ page }) => {
  await toStreamListing(page);
  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies")).toHaveClass(/open/);

  await expect(page.locator("#yourMovies .osback")).toHaveCount(0);
  await expect(page.locator("#yourMovies h2.osh")).toHaveCount(0);
  await expect(page.locator("#yourMovies .ossub")).toHaveCount(0);

  const firstChild = page.locator("#yourMoviesBody > *").first();
  await expect(firstChild).toHaveClass(/ymcard/);
});

test("CAS-539: closing Your Movies still works via the header's Agents chip", async ({ page }) => {
  await toStreamListing(page);
  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies")).toHaveClass(/open/);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#yourMovies")).not.toHaveClass(/open/);
});
