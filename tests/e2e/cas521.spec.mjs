// CAS-521 (Lee, real-device iOS TestFlight, 2026-08-15): in the collapsed agent bar (CAS-508/512/519) the
// active pill's coloured outline ran straight through the dimmed neighbour labels either side of it — the
// deck's coverflow paint (deckPaint()) pulls each neighbour card translateX(-d*34px) toward the centre, a
// shift sized for the ~200px+ expanded card that eats the whole inter-pill gap once the card shrinks to the
// collapsed row's 150px name-only pill. Fixed by not pulling collapsed neighbours toward the centre at all —
// they still shrink/dim/blur in place, so the swipe affordance holds, but the raw flex gap is left alone
// rather than being closed further, which keeps a neighbour legible even on the narrowest phone (widening
// the gap instead risks pushing it off-screen entirely there). This checks the labels either side of the
// active pill never overlap or touch it, with a long active name and a short one, and at the narrowest
// supported iPhone width — then re-runs the CAS-508/512/519 interactions the same paint code drives, to
// confirm nothing about swipe-to-switch, tap-to-expand or the sticky pin regressed.
//
// One real built agent is enough: the deck always also carries the built-in "All" card and the "+ New
// Agent" placeholder, so a single agent already has a neighbour on both sides once centred. A second real
// agent (via the deck's own "+ New Agent" card) is deliberately NOT used here — that path is independently
// broken on a clean, unmodified checkout (confirmed by stashing this ticket's diff and re-running the
// existing cas501.spec.mjs, which times out identically), unrelated to this fix, and out of this ticket's
// scope.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

/** For whichever pill is currently centred: the gap (negative) or overlap (positive, in px) between its
 * .dc-in outline box and the dc-name label immediately to its left/right. null where there is no such
 * neighbour (the centred pill sits at either end of the deck). */
function neighbourGaps(page){
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("#cascStrip .dcard")];
    const idx = cards.findIndex(c => c.classList.contains("is-centre"));
    const centre = cards[idx].querySelector(".dc-in").getBoundingClientRect();
    const rectOf = el => el ? el.querySelector(".dc-name").getBoundingClientRect() : null;
    const leftName = rectOf(cards[idx - 1]);
    const rightName = rectOf(cards[idx + 1]);
    return {
      left: leftName ? leftName.right - centre.left : null,     // >0 = the left label pokes into the pill
      right: rightName ? centre.right - rightName.left : null,  // >0 = the pill pokes into the right label
    };
  });
}

/** Build one agent and collapse the bar, landing with the deck [All, <agent>, +New] and the agent centred. */
async function oneAgentCollapsed(page, kind, name){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, name ?? cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(page.locator("#cascbar")).toHaveClass(/collapsed/);
}

test("CAS-521: the collapsed pill's outline clears both neighbour labels — short active name", async ({ page }) => {
  await oneAgentCollapsed(page, "cinema", "Blockbusters");   // short-ish (12 chars), the ticket's own example

  await expect(page.locator("#cascStrip .dcard.is-centre .dc-name")).toHaveText("Blockbusters");
  let gaps = await neighbourGaps(page);
  expect(gaps.left).toBeLessThan(0);
  expect(gaps.right).toBeLessThan(0);

  // The shortest possible active name — "All" — with only a right-hand neighbour to clear (first in the deck).
  // is-active (selection) lands immediately on click; is-centre (the deck's own scroll position) only lands
  // once the smooth-scroll settles, so wait for that before reading geometry.
  await page.locator("#cascStrip .dcard.all").click();
  await expect(page.locator("#cascStrip .dcard.all")).toHaveClass(/is-centre/);
  await expect(page.locator("#cascbar")).toHaveClass(/collapsed/);
  gaps = await neighbourGaps(page);
  expect(gaps.left).toBeNull();
  expect(gaps.right).toBeLessThan(0);

  // AC2: neighbours are dimmed, not hidden — the swipe affordance survives the fix.
  const neighbour = page.locator("#cascStrip .dcard:not(.is-centre)").first();
  await expect(neighbour.locator(".dc-name")).toBeVisible();
  const opacity = await neighbour.evaluate(el => Number(getComputedStyle(el.firstElementChild).opacity));
  expect(opacity).toBeGreaterThan(0);
});

test("CAS-521: the collapsed pill's outline clears both neighbour labels — long active name", async ({ page }) => {
  await oneAgentCollapsed(page, "stream", "Loved & Acclaimed");   // 17 chars, the longest cinema/stream preset

  await expect(page.locator("#cascStrip .dcard.is-centre .dc-name")).toHaveText(/Loved & Acclaimed/);
  const gaps = await neighbourGaps(page);
  expect(gaps.left).toBeLessThan(0);
  expect(gaps.right).toBeLessThan(0);
});

test("CAS-521: still clears both neighbours at the narrowest supported iPhone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });   // iPhone SE — the narrowest supported width
  await oneAgentCollapsed(page, "stream", "Loved & Acclaimed");   // the tighter, long-name case

  const gaps = await neighbourGaps(page);
  expect(gaps.left).toBeLessThan(0);
  expect(gaps.right).toBeLessThan(0);
});

test("CAS-521: swipe-to-switch, tap-to-expand and the CAS-519 sticky pin still work", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const bar = page.locator("#cascbar");
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(bar).toHaveClass(/collapsed/);
  const pinnedTop = await bar.evaluate(el => el.getBoundingClientRect().top);

  // Switch-by-tap (CAS-508/512): still just switches, still collapsed, still pinned at the same top.
  await page.locator("#cascStrip .dcard.all").click();
  await expect(page.locator("#cascStrip .dcard.all")).toHaveClass(/is-centre/);
  await expect(bar).toHaveClass(/collapsed/);
  expect(Math.abs(await bar.evaluate(el => el.getBoundingClientRect().top) - pinnedTop)).toBeLessThan(1);

  // Tap-to-expand (CAS-512): tapping the already-open pill expands the bar and returns to the top.
  await page.locator("#cascStrip .dcard.is-centre").click();
  await expect(bar).not.toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
