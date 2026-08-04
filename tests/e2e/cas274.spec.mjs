// CAS-274: the cascade bar leaves a gap under the Order control.
//
// Note on what is NOT asserted here: the bar is sticky, so listing cards legitimately pass BEHIND it as you
// scroll — a geometric "does any card overlap the sort control" check is always true and proves nothing. What
// the ticket is actually about is the bar reserving space below its last control, and painting that space, so
// the content sliding underneath never reads as touching the select. That is what these tests pin.
//
// The Order control's id was #sortBar when this spec was written; CAS-321 merged the sort pill and the
// jump-to chips into one #listCtl row, and the pill itself is #sortCtl — #sortBar no longer exists.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  // The listing has exactly one deck state — the compact rail — applied as soon as it renders.
  await expect(page.locator("#cascbar.rail")).toBeAttached();
}

test("CAS-274: there is real space between the Order control and the bar's bottom edge", async ({ page }) => {
  await toAgentListing(page);
  const gap = await page.evaluate(() => {
    const bar = document.querySelector("#cascbar").getBoundingClientRect();
    const sort = document.querySelector("#sortCtl").getBoundingClientRect();
    return bar.bottom - sort.bottom;
  });
  expect(gap, "the Order control sits hard against the bottom of the sticky bar").toBeGreaterThanOrEqual(6);
});

test("CAS-274: the gap survives scrolling, which is when it matters", async ({ page }) => {
  await toAgentListing(page);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(250);
  const gap = await page.evaluate(() => {
    const bar = document.querySelector("#cascbar").getBoundingClientRect();
    const sort = document.querySelector("#sortCtl").getBoundingClientRect();
    return bar.bottom - sort.bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(6);
});

test("CAS-274: the bar paints that gap, so content passing behind it is covered", async ({ page }) => {
  await toAgentListing(page);
  const bg = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#cascbar")).backgroundColor);
  // A reserved gap over a transparent bar would let the cards show through it and defeat the point.
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(bg).not.toBe("transparent");
});

test("CAS-274: the bar is still the sticky one — the gap is separating it from moving content", async ({ page }) => {
  await toAgentListing(page);
  const pos = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#cascbar")).position);
  expect(pos).toBe("sticky");
  const pad = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#cascbar")).paddingBottom);
  expect(pad, `the rail's bottom padding reads ${pad}`).not.toBe("0px");
});
