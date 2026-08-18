// CAS-557: the reported "keyboard goes unresponsive typing into the account email field" was diagnosed
// from the code, not reproduced on-device (see the ticket's amendment — no iOS device is available in this
// environment, and Lee relaxed AC1 to accept the code-level trigger with a post-ship device sign-off
// instead of gating on reproduction). The trigger, per that amendment: app_template.html's resize listener
// (~line 8046) called syncHeaderHeight()/armCascObserver()/syncCascCollapse() on every single "resize"
// event, completely undebounced, and armCascObserver() disconnects and reallocates an IntersectionObserver
// plus forces a layout read on every call. iOS fires a stream of resize events while the soft keyboard
// animates in and again as the predictive-text bar changes size, so every keystroke in a focused field paid
// for a full observer rebuild. The fix debounces the triple-call at 140ms, matching the deck's own resize
// handler (~line 7960, CAS-508), which already used this idiom.
//
// No soft keyboard exists in headless Chromium, so this drives the mechanism the fix relies on directly —
// the debounce coalescing a burst of "resize" events into a single pass — rather than the on-device symptom.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

/** Wraps the two named globals with call counters, returning nothing — read them back via window.__cas557. */
async function instrumentResizeHandlers(page){
  await page.evaluate(() => {
    window.__cas557 = { shh: 0, aco: 0 };
    const origSHH = window.syncHeaderHeight, origACO = window.armCascObserver;
    window.syncHeaderHeight = function(){ window.__cas557.shh++; return origSHH.apply(this, arguments); };
    window.armCascObserver = function(){ window.__cas557.aco++; return origACO.apply(this, arguments); };
  });
}

const fireResizeBurst = (page, n = 12) =>
  page.evaluate(count => { for (let i = 0; i < count; i++) window.dispatchEvent(new Event("resize")); }, n);

test("CAS-557: a burst of resize events coalesces into a single pass within 140ms, not one per event", async ({ page }) => {
  await freshApp(page);
  await instrumentResizeHandlers(page);

  await fireResizeBurst(page);
  // Still inside the debounce window — the burst must not have run anything synchronously or on a timer
  // shorter than 140ms.
  expect(await page.evaluate(() => window.__cas557)).toEqual({ shh: 0, aco: 0 });

  await page.waitForTimeout(220);
  expect(await page.evaluate(() => window.__cas557)).toEqual({ shh: 1, aco: 1 });
});

test("CAS-557: the debounce re-arms — a second burst after the first settles produces its own single pass", async ({ page }) => {
  await freshApp(page);
  await instrumentResizeHandlers(page);

  await fireResizeBurst(page);
  await page.waitForTimeout(220);
  expect(await page.evaluate(() => window.__cas557)).toEqual({ shh: 1, aco: 1 });

  await fireResizeBurst(page);
  await page.waitForTimeout(220);
  expect(await page.evaluate(() => window.__cas557)).toEqual({ shh: 2, aco: 2 });
});

test("CAS-557: --hdrh still reflects the real header height once the debounce settles", async ({ page }) => {
  await freshApp(page);
  await fireResizeBurst(page);
  await page.waitForTimeout(220);

  const [hdrh, headerHeight] = await page.evaluate(() => [
    getComputedStyle(document.documentElement).getPropertyValue("--hdrh").trim(),
    document.querySelector("header").offsetHeight,
  ]);
  expect(hdrh).toBe(`${headerHeight}px`);
});

test("CAS-557: the deck still collapses and expands correctly under scroll after the debounce change", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const bar = page.locator("#cascbar");
  await expect(bar).not.toHaveClass(/collapsed/);

  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveClass(/collapsed/);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).not.toHaveClass(/collapsed/);
});
