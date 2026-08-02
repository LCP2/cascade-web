// CAS-262: the onboarding steps use the width they are given.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, pickCard } from "./helpers.mjs";

/** The step column's width, and the frame it sits in, at the current viewport. */
const widths = page => page.evaluate(() => {
  const inner = document.querySelector("#onbStepInner");
  const frame = document.querySelector("#onbStep");
  return {
    inner: Math.round(inner.getBoundingClientRect().width),
    frame: Math.round(frame.getBoundingClientRect().width),
    scroll: Math.round(document.documentElement.scrollWidth),
  };
});

// Measured before and after the change, at 100% and at this build's UI scale:
//   360px viewport: 315 -> 333   390: 345 -> 363   430: 385 -> 403   900: 403 -> 479
// The floors sit a couple of px under each measurement so a font metric cannot make this flaky, but well
// above the old number — the point of the ticket is that these went UP.
const CASES = [
  { width: 360, atLeast: 330, wasAtMost: 316 },
  { width: 390, atLeast: 360, wasAtMost: 346 },
  { width: 430, atLeast: 400, wasAtMost: 386 },
  { width: 900, atLeast: 474, wasAtMost: 404 },   // the frame's own --flow-w cap is what stops it here
];

for(const { width, atLeast, wasAtMost } of CASES){
  test(`CAS-262: the step fills its frame at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    await freshApp(page);
    await page.locator("#splashCta").click();
    await expect(page.locator(".priobtn").first()).toBeVisible();

    const w = await widths(page);
    expect(w.inner, `the step column is ${w.inner}px inside a ${w.frame}px frame`).toBeGreaterThanOrEqual(atLeast);
    expect(w.inner, "the column is back to its old width").toBeGreaterThan(wasAtMost);
    // It fills the frame, and does not burst it.
    expect(w.inner).toBeLessThanOrEqual(w.frame);
    expect(w.scroll, "the page scrolls sideways").toBeLessThanOrEqual(width);
  });
}

test("CAS-262: the Continue bar lines up with the content it belongs to", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 });
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await page.waitForTimeout(600);          // the pane is still sliding when the heading first appears
  const [inner, cta] = await Promise.all([
    page.locator("#onbStepInner").boundingBox(),
    page.locator("#flowCta").boundingBox(),
  ]);
  expect(Math.abs(cta.x - inner.x), "the fixed Continue no longer aligns with the step").toBeLessThanOrEqual(2);
});

test("CAS-262: nothing on a real step overflows its column", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 860 });
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  const spill = await page.evaluate(() => {
    const inner = document.querySelector("#onbStepInner");
    const box = inner.getBoundingClientRect();
    return [...inner.querySelectorAll("*")]
      .filter(el => el.getBoundingClientRect().width > 0)
      .filter(el => el.getBoundingClientRect().right > box.right + 1)
      .map(el => el.className + " @" + Math.round(el.getBoundingClientRect().right));
  });
  expect(spill, `elements past the column's right edge: ${spill.join(", ")}`).toEqual([]);
});
