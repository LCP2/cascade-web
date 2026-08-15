// CAS-519 (Lee, real-device iOS, 2026-08-15): the collapsed agent box (CAS-508/512/513) scrolled away with
// the rest of the page instead of staying pinned under the header. Collapsing changes the bar's own box size
// (padding/--dcw/hidden children), and WebKit has a known bug where a position:sticky element that resizes
// while the scroll crossing its own sticky threshold is still in flight loses its stuck position for the rest
// of that gesture. This asserts the bar stays pinned at the header's own height across several further scroll
// positions, not just the one where it first collapses.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-519: the collapsed bar stays pinned to the header at every further scroll position", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const bar = page.locator("#cascbar");

  // AC3, right at the collapse line (as CAS-508 already covers): the shrunk bar still doesn't cover the
  // first card underneath it.
  await page.evaluate(() => window.scrollTo(0, 40));
  await expect(bar).toHaveClass(/collapsed/);
  const barBottomAtLine = await bar.evaluate(el => el.getBoundingClientRect().bottom);
  const firstCardTopAtLine = await page.locator("#groups .card, #groups .stub").first()
    .evaluate(el => el.getBoundingClientRect().top);
  expect(firstCardTopAtLine).toBeGreaterThanOrEqual(barBottomAtLine - 1);

  // Several further scroll positions after the collapse line — not just the one where it first flips. The
  // bug this guards against is the bar's top DRIFTING with scrollY once it's supposed to be pinned (it would
  // grow more negative at each deeper scroll if it had come loose); pinned means every reading matches the
  // very first one, regardless of what that absolute value is (--ui-scale's zoom means it needn't equal the
  // raw --hdrh px figure exactly).
  let pinnedTop = null;
  for(const y of [300, 900, 1800]){
    await page.evaluate(target => window.scrollTo(0, target), y);
    await expect(bar).toHaveClass(/collapsed/);
    const top = await bar.evaluate(el => el.getBoundingClientRect().top);
    if(pinnedTop === null) pinnedTop = top;
    else expect(Math.abs(top - pinnedTop)).toBeLessThan(1);
  }
});

test("CAS-519: tap-to-expand and switch-by-tap still work while the bar is pinned deep in the scroll", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const bar = page.locator("#cascbar");
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(bar).toHaveClass(/collapsed/);

  // Switching agents from deep in the scroll still just switches, stays pinned, no jump to the top.
  await page.locator("#cascStrip .dcard.all").click();
  await expect(page.locator("#cascStrip .dcard.all")).toHaveClass(/is-centre/);
  await expect(bar).toHaveClass(/collapsed/);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // Tapping the now-open agent expands it back to full view, same as CAS-512 already covers at scrollY 300.
  await page.locator("#cascStrip .dcard.is-centre").click();
  await expect(bar).not.toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
