// CAS-915 AC8: landing on the Watch listing after membership must not carry over whatever scroll
// position the page had before the listing was built — reproduces the "opens part-scrolled" bug
// report by scrolling the page first, since a fresh test page starts at 0 either way.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

test("membership CTA lands with the Watch listing scrolled to the top (CAS-915 AC8)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);   // v2_services -> v2_done -> membership

  // Simulate the page already carrying scroll from before the listing rebuilds — the reset must win
  // regardless of where the page started, not merely happen to be 0 on a page that never scrolled.
  await page.evaluate(() => window.scrollTo(0, 400));

  await toListing(page);
  const scrollTop = await page.evaluate(() =>
    window.scrollY || document.documentElement.scrollTop || document.body.scrollTop);
  expect(scrollTop).toBe(0);
});
