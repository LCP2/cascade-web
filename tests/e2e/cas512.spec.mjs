// CAS-512: the collapsed agent box (CAS-508) kept left/right swipe to switch agents, but getting back to
// the full expanded view required scrolling all the way back to the top by hand. A tap on the box now
// expands it immediately, from wherever the user has scrolled to — without disturbing the swipe-to-switch
// gesture it sits alongside. The two stay distinct: tapping the agent already open expands it; tapping a
// different agent still just switches to it and stays collapsed, exactly as swiping there already did.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-512: tapping the collapsed box's open agent expands it back to full view", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const bar = page.locator("#cascbar");
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);

  // The centred pill is the agent already open — a tap on it (not a swipe) is the expand gesture.
  await expect(page.locator("#cascStrip .dcard.is-centre")).toHaveClass(/is-active/);
  await page.locator("#cascStrip .dcard.is-centre").click();

  await expect(bar).not.toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("CAS-512: tapping a different agent on the collapsed box still just switches, and stays collapsed", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const bar = page.locator("#cascbar");
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);

  // All sits ahead of the freshly-built agent in the deck and isn't the one currently open.
  await expect(page.locator("#cascStrip .dcard.all")).not.toHaveClass(/is-active/);
  await page.locator("#cascStrip .dcard.all").click();

  await expect(page.locator("#cascStrip .dcard.all")).toHaveClass(/is-centre/);
  await expect(page.locator("#cascStrip .dcard.all")).toHaveClass(/is-active/);
  // Switching agents from the collapsed row is still a same-place operation — no jump to the top.
  await expect(bar).toHaveClass(/collapsed/);
  const scrollAfter = await page.evaluate(() => window.scrollY);
  expect(scrollAfter).toBeGreaterThan(0);
});
