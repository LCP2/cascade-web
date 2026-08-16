// CAS-528: the "Watch it" filter popover is positioned once, at open time, from #cascbar's rect
// (positionFilterPanel), then parented into #cascbar itself. #cascbar is sticky and also toggles a
// .collapsed class on scroll (CAS-512/CAS-519), so scrolling while the popover is open left its fixed
// offsets stale against the card/button underneath — it looked detached, stuck in place while the deck
// kept scrolling. Fix: a scroll listener closes the panel, the same convention the outside-tap listener
// just above it already uses.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-528: scrolling the page closes an open Watch it filter panel instead of leaving it stranded", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const filterBtn = page.locator(".dcard:not(.all) .dc-filter").first();
  await filterBtn.click();
  const pop = page.locator(".cpop.fpop");
  await expect(pop).toBeVisible();
  await expect(filterBtn).toHaveClass(/open/);

  await page.evaluate(() => window.scrollTo(0, 300));

  await expect(pop).toHaveCount(0);
  await expect(filterBtn).not.toHaveClass(/open/);
  await expect(filterBtn).toHaveAttribute("aria-expanded", "false");
});
