// CAS-249: Critics & awards is a continuous score plus a counted awards ladder, in one card.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

test("CAS-249: the score is a real slider and the awards are counted", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards.find(c => /Loved/.test(c.name))?.name || cards[0].name);
  await expect(page.locator(".osh", { hasText: "Mission" })).toBeVisible();

  const card = page.locator(".osdial", { hasText: "Critics & awards" });
  await expect(card).toBeVisible();
  // Two sliders in the one card — the score and the awards ladder — not two cards.
  await expect(card.locator("input[type=range]")).toHaveCount(2);
  const score = card.locator("#onbDial_crit");
  const awards = card.locator("#onbDial_awards");
  await expect(score).toHaveAttribute("max", "100");
  await expect(score).toHaveAttribute("step", "1");
  await expect(awards).toHaveAttribute("max", "4");

  // The awards rungs are counts, ending at Winner.
  const rungs = await card.locator(".vlabels").nth(1).locator(".vsnap").allTextContents();
  expect(rungs[0]).toMatch(/Any/);
  expect(rungs[1]).toMatch(/1 nom/);
  expect(rungs[2]).toMatch(/2\+/);
  expect(rungs[3]).toMatch(/3\+/);
  expect(rungs[4]).toMatch(/Winner/);

  // Dragging the score to a value BETWEEN the named marks really filters there — that is what
  // "continuous, not click-to-preset" means, and it is the whole of this half of the ticket.
  await score.fill("73");
  await score.dispatchEvent("input");
  const at73 = await page.evaluate(() => ({ v: onbApply().selCritScore, n: onbCount() }));
  expect(at73.v).toBe(73);
  await score.fill("74");
  await score.dispatchEvent("input");
  const at74 = await page.evaluate(() => ({ v: onbApply().selCritScore, n: onbCount() }));
  expect(at74.v).toBe(74);
  expect(at74.n, "a tighter score must never admit more films").toBeLessThanOrEqual(at73.n);
  await expect(card.locator(".dval")).toContainText("74");
});

test("CAS-249: the awards ladder narrows at every step, ending at Winner", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  const card = page.locator(".osdial", { hasText: "Critics & awards" });
  // Start from a clean bar so only the awards rung is moving.
  await page.evaluate(() => { onbFlow.critScore = 0; onbFlow.awardStop = 0; });

  const counts = [];
  for(const i of [0, 1, 2, 3, 4]){
    counts.push(await page.evaluate(rung => {
      onbFlow.awardStop = rung;
      return MOVIES.filter(m => watchesFilm(m, onbApply())).length;
    }, i));
  }
  for(let i = 1; i < counts.length; i++){
    expect(counts[i], `rung ${i} widened the set: ${counts.join(" → ")}`).toBeLessThanOrEqual(counts[i - 1]);
  }
  expect(counts[4], "no film clears Winner").toBeGreaterThan(0);

  // …and tapping a rung is still one tap, on the second ladder rather than the first.
  await page.evaluate(() => { onbFlow.awardStop = 0; renderOnbStep(onbStepKey); });
  await card.locator(".vlabels").nth(1).locator(".vsnap").nth(4).click();
  expect(await page.evaluate(() => onbApply().selAwards)).toBe(4);
  expect(await page.evaluate(() => onbApply().selCritScore), "the score must not move with the awards").toBe(0);
});
