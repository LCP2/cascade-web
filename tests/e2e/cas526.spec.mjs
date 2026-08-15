// CAS-526: CAS-519's single post-toggle reflow held on desktop/emulated WebKit but not on a real iOS device --
// the eased `transition:padding .18s ease` (and the matching .deckstrip/.dcard/.dc-in rules) keeps resizing
// the bar's box for the rest of that 180ms window, and a real finger-drag gesture is very likely still in
// flight that long after the threshold crossing, re-tripping WebKit's sticky-loses-its-pin bug on every one
// of those resizes, not just the first. syncCascCollapse() now jumps a scroll-driven toggle to its final size
// in one frame (a `.no-transition` class added just before the toggle, removed again next frame) instead of
// animating through it, while leaving expandCascBar()'s own deliberate scroll (CAS-513) animated as before.
// CI has no real device to confirm AC1/AC3 against, so this asserts the mechanism directly instead: the class
// is present at the instant of a scroll-driven toggle and absent for the whole of a tap-driven (expandCascBar)
// one.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function armClassLog(page){
  await page.evaluate(() => {
    window.__cascClassLog = [];
    const bar = document.getElementById("cascbar");
    const mo = new MutationObserver(muts => {
      for(const m of muts){
        if(m.attributeName === "class") window.__cascClassLog.push(bar.className);
      }
    });
    mo.observe(bar, { attributes: true, attributeFilter: ["class"] });
  });
}

test("CAS-526: a scroll-driven collapse jumps in one frame instead of animating through the WebKit sticky bug", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const bar = page.locator("#cascbar");
  await armClassLog(page);

  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);

  // no-transition must be on the SAME class snapshot that first carries collapsed -- added before the
  // toggle, not after -- and gone again shortly after (removed next frame), so it doesn't linger and eat
  // every future transition on the bar.
  const log = await page.evaluate(() => window.__cascClassLog);
  const collapseIdx = log.findIndex(c => /\bcollapsed\b/.test(c));
  expect(collapseIdx).toBeGreaterThanOrEqual(0);
  expect(log[collapseIdx]).toMatch(/\bno-transition\b/);

  await expect.poll(() => page.evaluate(() =>
    document.getElementById("cascbar").classList.contains("no-transition"))).toBe(false);
  await expect(bar).toHaveClass(/collapsed/);
});

test("CAS-526: expandCascBar's own tap-to-expand scroll keeps its ease, not the one-frame jump", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const bar = page.locator("#cascbar");
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);

  await armClassLog(page);

  // The centred pill is the agent already open -- a tap on it is the expand gesture (CAS-512).
  await page.locator("#cascStrip .dcard.is-centre").click();
  await expect(bar).not.toHaveClass(/collapsed/);

  const log = await page.evaluate(() => window.__cascClassLog);
  // Not one single logged class snapshot ever carried no-transition -- the deliberate expand path keeps
  // the CSS ease the whole way through.
  expect(log.some(c => /\bno-transition\b/.test(c))).toBe(false);
});
