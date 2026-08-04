// CAS-323: the listing card's poster/tombstone shrinks ~10% and moves flush to the card's left edge,
// handing the reclaimed width to the text column. The availability strip and control row are untouched.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page, kind = "stream"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator("#groups .card").first()).toBeVisible();
}

test("CAS-323: the poster is roughly 10% smaller than the old 124px tombstone", async ({ page }) => {
  await toAgentListing(page);
  const width = await page.evaluate(() =>
    document.querySelector("#groups .card .poster").getBoundingClientRect().width);
  // Rendered width is CSS px * the CAS-157 --ui-scale zoom (1.12), so 124px old / 112px new
  // measure as ~138.9px / ~125.4px on screen. Allow a few px either side for rounding.
  expect(width, `poster is ${width}px wide`).toBeGreaterThan(118);
  expect(width, `poster is ${width}px wide`).toBeLessThan(132);
});

test("CAS-323: the poster sits flush against the card's left edge", async ({ page }) => {
  await toAgentListing(page);
  const gap = await page.evaluate(() => {
    const card = document.querySelector("#groups .card");
    const poster = card.querySelector(".poster");
    return poster.getBoundingClientRect().left - card.getBoundingClientRect().left;
  });
  // Only the 1px card border should separate them now — the old 13px cbody gutter is gone.
  expect(gap, `the poster sits ${gap}px in from the card's left edge`).toBeLessThan(3);
});

test("CAS-323: the reclaimed gutter goes to the text column, not just the poster shrink", async ({ page }) => {
  await toAgentListing(page);
  const offset = await page.evaluate(() => {
    const card = document.querySelector("#groups .card");
    const title = card.querySelector(".title");
    return title.getBoundingClientRect().left - card.getBoundingClientRect().left;
  });
  // It used to be ~150 CSS px (1 border + 13 padding + 124 poster + 12 gap), ~168px rendered at the
  // CAS-157 1.12x zoom. Trimming the padding as well as the poster should land it well under that.
  expect(offset, `the title starts ${offset}px in from the card's left edge`).toBeLessThan(155);
});

test("CAS-323: the play button is still drawn on the poster", async ({ page }) => {
  await toAgentListing(page);
  const found = await page.evaluate(() => {
    const posters = [...document.querySelectorAll("#groups .card .poster")];
    return posters.some(p => p.querySelector(".pplay"));
  });
  expect(found, "no card in this listing shows a play button on its poster").toBe(true);
});

test("CAS-323: the availability strip keeps its own, untouched left inset", async ({ page }) => {
  await toAgentListing(page);
  const gap = await page.evaluate(() => {
    const card = document.querySelector("#groups .card");
    const win = card.querySelector(".bandw .win");
    if (!win) return null;
    return win.getBoundingClientRect().left - card.getBoundingClientRect().left;
  });
  if (gap === null) test.skip();
  // .bandw's own 13px padding is untouched by this ticket — unlike the poster, this row does not go flush.
  expect(gap, `the availability strip starts ${gap}px in from the card's left edge`).toBeGreaterThan(10);
});
