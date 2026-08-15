// CAS-513: expanding the agent box out of its collapsed state (CAS-508) used to be jumpy — the trigger
// (scroll-to-top, or CAS-512's tap-to-expand) called an instant window.scrollTo with no easing, so the
// collapsed->expanded CSS class flip landed in a single frame with no transitions on the properties that
// actually changed (deck card width, card padding, name font-size). Expand now scrolls smoothly (the same
// scroll-driven class flip collapse already gets from a real manual scroll) and the geometry that changes
// on the flip eases instead of snapping — both gated on prefers-reduced-motion, same as the rest of the deck.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function openCollapsedCascade(page) {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const bar = page.locator("#cascbar");
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);
  return bar;
}

test("CAS-513: expanding the collapsed box eases — the deck geometry transitions, not snaps", async ({ page }) => {
  const bar = await openCollapsedCascade(page);

  const durations = await page.evaluate(() => ({
    bar: getComputedStyle(document.getElementById("cascbar")).transitionDuration,
    card: getComputedStyle(document.querySelector("#cascStrip .dcard")).transitionDuration,
    name: getComputedStyle(document.querySelector("#cascStrip .dc-name")).transitionDuration,
  }));
  expect(durations.bar).not.toBe("0s");
  expect(durations.card).not.toBe("0s");
  expect(durations.name).not.toBe("0s");

  // The centred pill is the agent already open — tapping it is the expand gesture (CAS-512).
  await page.locator("#cascStrip .dcard.is-centre").click();

  await expect(bar).not.toHaveClass(/collapsed/);
  // A smooth scroll settles asynchronously — poll rather than asserting the jump is already done.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("CAS-513: reduced motion drops the easing — expand still lands, just without a transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const bar = await openCollapsedCascade(page);

  const durations = await page.evaluate(() => ({
    bar: getComputedStyle(document.getElementById("cascbar")).transitionDuration,
    card: getComputedStyle(document.querySelector("#cascStrip .dcard")).transitionDuration,
    name: getComputedStyle(document.querySelector("#cascStrip .dc-name")).transitionDuration,
  }));
  expect(durations.bar).toBe("0s");
  expect(durations.card).toBe("0s");
  expect(durations.name).toBe("0s");

  await page.locator("#cascStrip .dcard.is-centre").click();

  await expect(bar).not.toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
