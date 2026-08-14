// CAS-508: the agent deck (CAS-136/CAS-172) stayed sticky at full height for the whole listing, and on a
// phone that cost too much vertical space — reported on-device as the deck reading "clipped" once scrolled
// into a film list. It now collapses to a name-only, still-swipeable/tappable row once you scroll past it
// (narrower than CAS-136's original collapse, which also dropped the Edit/actions row CAS-172 wanted kept):
// hidden are icon, sub-line, the Learning chip, actions, search, sort and the jump bar — all one scroll away,
// same as before this ticket. Only the switcher itself has to survive scrolling.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-508: the deck collapses to a name-only row once scrolled past, full form at rest", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const bar = page.locator("#cascbar");
  await expect(bar).not.toHaveClass(/collapsed/);
  const fullHeight = await bar.evaluate(el => el.getBoundingClientRect().height);

  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);
  const collapsedHeight = await bar.evaluate(el => el.getBoundingClientRect().height);
  expect(collapsedHeight).toBeLessThan(fullHeight * 0.6);

  // The switcher itself stays: the deck strip (name pills) is still visible and still holds the open agent.
  await expect(page.locator("#cascStrip")).toBeVisible();
  await expect(page.locator("#cascStrip .dcard.is-centre .dc-name")).toBeVisible();
  // The controls that made room for it are the ones that went — not the switcher.
  await expect(page.locator("#cascStrip .dcard.is-centre .dc-acts")).toBeHidden();

  // Scrolling back to the top restores the full row — nothing about the rest state changed. Not asserted
  // pixel-exact against the earlier reading: the per-cascade "N films right now …" sub-line can rewrap by a
  // line between the two reads (async streaming, CAS-129), which is unrelated to collapse/expand.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).not.toHaveClass(/collapsed/);
  const reExpandedHeight = await bar.evaluate(el => el.getBoundingClientRect().height);
  expect(reExpandedHeight).toBeGreaterThan(collapsedHeight * 1.5);
});

test("CAS-508: switching agents from the collapsed row needs no scroll back up, and the list scroll position holds", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const bar = page.locator("#cascbar");
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);

  // The All card sits first in the deck, ahead of the agent just built. Switching to it while collapsed and
  // scrolled must not need a trip back to the top first — that's the whole point of this ticket. (The exact
  // scrollY can shift a little: All's listing is a different length, and the browser's own scroll anchoring
  // can nudge the offset when the content above the fold changes — that's normal and not what AC1 is about.)
  await page.locator("#cascStrip .dcard.all").click();
  await expect(page.locator("#cascStrip .dcard.all")).toHaveClass(/is-centre/);

  const scrollAfter = await page.evaluate(() => window.scrollY);
  expect(scrollAfter).toBeGreaterThan(0);   // not bounced back to the top to complete the switch
  await expect(bar).toHaveClass(/collapsed/);
});

test("CAS-508: the collapsed row never covers the first film card", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  await page.evaluate(() => window.scrollTo(0, 40));
  await expect(page.locator("#cascbar")).toHaveClass(/collapsed/);

  const barBottom = await page.locator("#cascbar").evaluate(el => el.getBoundingClientRect().bottom);
  const firstCardTop = await page.locator("#groups .card, #groups .stub").first()
    .evaluate(el => el.getBoundingClientRect().top);
  // The listing scrolled under the sticky chrome exactly as it always did — this only shrank the chrome.
  expect(firstCardTop).toBeGreaterThanOrEqual(barBottom - 1);
});
