// CAS-511: tapping into the cascade search box (CAS-136) used to re-collapse the deck bar (CAS-508) before
// any text could be entered — a mobile browser scrolls a focused input above the keyboard, and that read as
// a genuine scroll past the collapse line to syncCascCollapse(), which promptly hid .cascsearch along with
// the input the user had just tapped into. The bar now holds still for the duration of the search interaction.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-511: focusing the search input keeps the bar expanded through the interaction", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const bar = page.locator("#cascbar");
  await expect(bar).not.toHaveClass(/collapsed/);

  // Open search from the at-rest (expanded) bar, same as the reported repro.
  await page.locator("#cascStrip .dcard.is-centre .dc-search").click();
  await expect(page.locator("#cascSearch")).toBeVisible();
  const input = page.locator("#cascSearchInput");
  await expect(input).toBeFocused();

  // Simulate the scroll a mobile browser performs to bring a focused field above the keyboard — this is
  // exactly what used to trip the collapse threshold mid-tap (AC1).
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).not.toHaveClass(/collapsed/);
  await expect(page.locator("#cascSearch")).toBeVisible();
  await expect(input).toBeFocused();

  // A search term can be typed and its results seen without the box collapsing mid-interaction (AC2).
  await input.fill(cards[0].name.slice(0, 3));
  await page.waitForTimeout(150);
  await expect(bar).not.toHaveClass(/collapsed/);
  await expect(page.locator("#cascSearch")).toBeVisible();

  // Existing collapse-on-scroll is unaffected once the search interaction ends (AC3) — close search (which
  // also drops the filter term, restoring the full listing) rather than merely blurring, so the page is tall
  // enough to actually cross the collapse threshold again.
  await page.locator("#cascSearchClose").click();
  await expect(page.locator("#cascSearch")).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);
});
