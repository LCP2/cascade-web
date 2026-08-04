// CAS-276: the listing card's use of space — more synopsis, a tombstone that stops where the scores do,
// and the Style line pulled up under the title.
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

test("CAS-276: the synopsis shows three lines, not two", async ({ page }) => {
  await toAgentListing(page);
  const clamp = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#groups .card .synopsis")).webkitLineClamp);
  expect(clamp).toBe("3");
});

test("CAS-276: an opened card still shows the synopsis in full", async ({ page }) => {
  await toAgentListing(page);
  const card = page.locator("#groups .card").first();
  await card.locator(".title").click();
  await expect(card).toHaveClass(/expanded/);
  const clamp = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#groups .card.expanded .synopsis")).webkitLineClamp);
  // Clamping an OPENED card would hide the thing opening it was for.
  expect(clamp === "none" || clamp === "unset" || clamp === "").toBe(true);
});

test("CAS-276: the tombstone no longer runs past the IMDb lozenge", async ({ page }) => {
  await toAgentListing(page);
  const worst = await page.evaluate(() => {
    let max = -Infinity;
    document.querySelectorAll("#groups .card").forEach(card => {
      const tomb = card.querySelector(".ptomb"), imdb = card.querySelector(".r-scores .m");
      if(!tomb || !imdb) return;
      max = Math.max(max, tomb.getBoundingClientRect().bottom - imdb.getBoundingClientRect().bottom);
    });
    return max;
  });
  // It used to reach 59.5px past it, every worst case being a card carrying a scale badge.
  expect(worst, `the tombstone overhangs the IMDb lozenge by ${worst}px`).toBeLessThanOrEqual(10);
});

test("CAS-276: the scale badge sits with the awards, not under the poster", async ({ page }) => {
  await toAgentListing(page);
  const where = await page.evaluate(() => ({
    inTomb: document.querySelectorAll("#groups .ptomb .tentbadge").length,
    inAwards: document.querySelectorAll("#groups .r-awards .tentbadge").length,
  }));
  expect(where.inTomb, "the badge is still hanging off the poster").toBe(0);
  expect(where.inAwards, "no card in this listing carries a scale badge at all").toBeGreaterThan(0);
});

test("CAS-353: the awards row doesn't regress to the old three-line wrap", async ({ page }) => {
  await toAgentListing(page);
  const tallest = await page.evaluate(() => {
    let max = 0;
    document.querySelectorAll("#groups .r-awards").forEach(r => {
      max = Math.max(max, r.getBoundingClientRect().height);
    });
    return max;
  });
  // CAS-353 moved this row back under the IMDb line — the text column only, not the full card width CAS-276
  // gave it — so it wrapping to two lines in that narrower column is expected (that's what .mrow's own
  // flex-wrap is for) and no longer the bug this test guards. What's still a bug is the ORIGINAL bug: squeezed
  // into the ~195px column alongside the scale badge, this row used to reach 89.6px — three wrapped lines.
  expect(tallest, `the awards row is ${tallest}px tall`).toBeLessThan(89.6);
});

test("CAS-276: the Style line rides up under the title", async ({ page }) => {
  await toAgentListing(page);
  const gap = await page.evaluate(() => {
    const card = document.querySelector("#groups .card");
    return card.querySelector(".metaline").getBoundingClientRect().top
         - card.querySelector(".title").getBoundingClientRect().bottom;
  });
  // It sat a full 9px grid gutter below the title, which read as two separate facts rather than one thought.
  expect(gap, `the title-to-Style gap is ${gap}px`).toBeLessThan(7);
  expect(gap, "the two must not collide").toBeGreaterThan(0);
});

test("CAS-276: nothing on the card is clipped by the tighter spacing", async ({ page }) => {
  await toAgentListing(page);
  const clipped = await page.evaluate(() => {
    const card = document.querySelector("#groups .card");
    const bad = [];
    ["title", "metaline", "r-money", "r-scores", "r-awards"].forEach(cls => {
      const el = card.querySelector("." + cls);
      if(el && el.scrollHeight > el.clientHeight + 1) bad.push(cls);
    });
    return bad;
  });
  // The Style line is deliberately ellipsised, so it is excluded from this check by using scrollHeight only.
  expect(clipped.filter(c => c !== "metaline")).toEqual([]);
});
