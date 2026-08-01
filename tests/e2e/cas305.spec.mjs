// CAS-305: the onboarding screens (.splash, .sharpstep, .memb) cap their own width at --flow-w — the
// phone-width column CAS-188/CAS-262 deliberately draws the flow at — but each also carries its own
// `background`, so capping the box capped the background with it. Above --flow-w (every desktop width;
// phones are already narrower than the cap) the app underneath showed through on both sides. The fix adds
// a box-shadow the size of the viewport, which paints the same surface out to the real edges without
// touching the box's own width.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow } from "./helpers.mjs";

test.use({ viewport: { width: 1280, height: 900 } });

/** The colour `var(--bg)` actually resolves to, read the same way the browser would compare it. */
async function bgColor(page){
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--bg)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
}

/** The element's own full-bleed backdrop: its box-shadow, and how big the viewport is right now. */
async function backdrop(page, selector){
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const boxShadow = el ? getComputedStyle(el).boxShadow : null;
    return { boxShadow, vw: window.innerWidth, vh: window.innerHeight };
  }, selector);
}

function assertFullBleed(boxShadow, vw, vh, bg, label){
  expect(boxShadow, `${label}: no box-shadow backdrop found`).not.toBe("none");
  expect(boxShadow, `${label}: backdrop is not painted in the page background colour`).toContain(bg);
  const lengths = boxShadow.match(/-?\d+(\.\d+)?px/g).map(parseFloat);
  const spread = lengths[3];
  // Anything narrower than the bigger viewport dimension leaves a sliver of the real page visible at
  // the corners once the shadow's rounded rect clears the box — this is the bleed-through the ticket saw.
  expect(spread, `${label}: backdrop spread too small to reach the viewport edge`).toBeGreaterThanOrEqual(Math.max(vw, vh));
}

test("CAS-305: the splash background reaches the viewport edge on a desktop width", async ({ page }) => {
  await freshApp(page);
  const bg = await bgColor(page);
  const { boxShadow, vw, vh } = await backdrop(page, "#splash");
  assertFullBleed(boxShadow, vw, vh, bg, "#splash");
});

test("CAS-305: the sharpening step and the membership screen carry the same full-bleed backdrop", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await expect(page.locator("#onbStep.open")).toBeVisible();
  const bg = await bgColor(page);

  let { boxShadow, vw, vh } = await backdrop(page, "#onbStep");
  assertFullBleed(boxShadow, vw, vh, bg, "#onbStep");

  await finishFlow(page);
  await expect(page.locator("#membScreen.open")).toBeVisible();
  ({ boxShadow, vw, vh } = await backdrop(page, "#membScreen"));
  assertFullBleed(boxShadow, vw, vh, bg, "#membScreen");
});
