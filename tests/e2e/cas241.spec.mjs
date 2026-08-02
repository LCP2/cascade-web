// CAS-241: the Watch-status collapse control is a thumb target and points back the way it collapses.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function openWatchPanel(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await card.locator(".ctl.watch").click();
  await expect(card.locator(".cpop")).toBeVisible();
  return card;
}

test("CAS-241: the collapse control is thumb-sized and points left", async ({ page }) => {
  const card = await openWatchPanel(page);
  const close = card.locator(".cpop .cclose");

  const box = await close.boundingBox();
  expect(box.width, "the collapse target is narrower than a thumb").toBeGreaterThanOrEqual(44);
  expect(box.height, "the collapse target is shorter than a thumb").toBeGreaterThanOrEqual(44);

  // A down chevron turned a quarter clockwise reads as "<".
  const turn = await close.locator("svg").evaluate(el => getComputedStyle(el).transform);
  expect(turn, "the arrow is not turned at all").not.toBe("none");
  // rotate(90deg) is matrix(0, 1, -1, 0, 0, 0) — the sign of b tells left from right.
  const [a, b] = turn.replace(/matrix\(|\)/g, "").split(",").map(Number);
  expect(Math.round(a)).toBe(0);
  expect(Math.round(b), "the arrow points the wrong way for a leftward collapse").toBe(1);

  // …and it still closes the panel.
  await close.click();
  await expect(card.locator(".cpop")).toHaveCount(0);
});

// CAS-311: CAS-278 replaced the four-answer row with a five-answer, best-first, top-to-bottom scale
// (WATCH_STEPS) — a deliberate design change, not a regression. The invariant this test guards is still
// "no answer is truncated at 360px"; it just checks it against today's five answers instead of the
// original four.
test("CAS-311: the five answers are not squeezed at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const card = await openWatchPanel(page);
  const segs = card.locator(".cpop .cseg");
  await expect(segs).toHaveCount(5);
  const labels = await segs.locator(".cl").evaluateAll(els => els.map(e => ({
    text: e.textContent.trim(), clipped: e.scrollWidth > e.clientWidth + 1,
  })));
  expect(labels.map(l => l.text)).toEqual(["Wow!", "Watch Again", "So-so", "Disliked", "Won't Watch"]);
  for(const l of labels) expect(l.clipped, `"${l.text}" is being truncated at 360px`).toBe(false);
});

test("CAS-241: the two panels close from opposite sides, pointing opposite ways", async ({ page }) => {
  const card = await openWatchPanel(page);
  const watch = await card.locator(".cpop .cclose svg").evaluate(el => getComputedStyle(el).transform);
  await page.keyboard.press("Escape");
  await card.locator(".ctl.notify").click();
  const notify = await card.locator(".cpop.npop .cclose svg").evaluate(el => getComputedStyle(el).transform);
  expect(watch, "both panels' arrows point the same way").not.toBe(notify);
});
