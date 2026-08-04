// CAS-353: two card-layout bugs from the 0.8.5 review. The streaming card's meta line (genres · language) was
// wrapping onto a second line instead of eliding — Safari on iPhone was measured failing to shrink the grid
// item below its text's natural width, which a short cinema-card line never triggered. And the awards row was
// spanning the full card width, running under the poster/tombstone as well as under the IMDb line it actually
// belongs beside.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-353: no card's meta line wraps onto a second line", async ({ page }) => {
  await toAgentListing(page, "stream");
  const wrapped = await page.evaluate(() => {
    let n = 0;
    document.querySelectorAll("#groups .card .metaline").forEach(el => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      if (el.scrollHeight > lineHeight * 1.4) n++;
    });
    return n;
  });
  expect(wrapped, "at least one .metaline wrapped past a single line").toBe(0);
});

test("CAS-353: award chips sit under the scores row, not spanning the poster too", async ({ page }) => {
  await toAgentListing(page, "stream");
  const { checked, mismatches } = await page.evaluate(() => {
    const bad = [];
    let n = 0;
    document.querySelectorAll("#groups .card").forEach(card => {
      const awards = card.querySelector(".r-awards");
      const scores = card.querySelector(".r-scores");
      if (!awards || !awards.textContent.trim()) return;
      n++;
      const aw = awards.getBoundingClientRect(), sc = scores.getBoundingClientRect();
      if (Math.round(aw.left) !== Math.round(sc.left) || Math.round(aw.width) !== Math.round(sc.width)) {
        bad.push(card.id);
      }
    });
    return { checked: n, mismatches: bad };
  });
  expect(checked, "no card in this listing carried an award chip to check").toBeGreaterThan(0);
  expect(mismatches).toEqual([]);
});
