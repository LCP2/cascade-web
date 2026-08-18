// CAS-571: the Find/Watch header chip marks are rebuilt to the approved design — gradient-filled at rest
// (previewing the gradient the chip takes when selected), flat white when the chip is selected, and the
// Watch bookmark's play notch is a real SVG mask cut, not a flat-coloured triangle drawn on top.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toStreamListing(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
}

test("CAS-571: at rest, Find is the violet-cyan gradient and Watch is the rose gradient — neither is grey", async ({ page }) => {
  await toStreamListing(page);

  // Find starts active (the deck/listing home view), so switch to Watch to see Find at rest.
  await page.locator("#moviesBtn").click();
  await expect(page.locator("#agentsBtn")).not.toHaveClass(/active/);

  const findMcf = await page.locator("#agentsBtn").evaluate(el => getComputedStyle(el).getPropertyValue("--mcf").trim());
  expect(findMcf).toBe("url(#mcFindGrad)");

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#moviesBtn")).not.toHaveClass(/active/);
  const watchMcf = await page.locator("#moviesBtn").evaluate(el => getComputedStyle(el).getPropertyValue("--mcf").trim());
  expect(watchMcf).toBe("url(#mcWatchGrad)");
});

test("CAS-571: selected, the mark goes flat white and the chip carries the gradient", async ({ page }) => {
  await toStreamListing(page);

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#moviesBtn")).toHaveClass(/active/);
  const activeMcf = await page.locator("#moviesBtn.active .mcicon").evaluate(el =>
    getComputedStyle(el).getPropertyValue("--mcf").trim());
  expect(activeMcf).toBe("#fff");

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
  const findActiveMcf = await page.locator("#agentsBtn.active .mcicon").evaluate(el =>
    getComputedStyle(el).getPropertyValue("--mcf").trim());
  expect(findActiveMcf).toBe("#fff");
});

test("CAS-571: the Watch bookmark's play notch is a real mask cut, not a separately-painted triangle", async ({ page }) => {
  await toStreamListing(page);

  const watchPaths = page.locator("#moviesBtn .mcicon path");
  await expect(watchPaths).toHaveCount(1);
  await expect(watchPaths.first()).toHaveAttribute("mask", "url(#mcWatchMask)");

  // The shared mask/gradient defs exist exactly once, outside both chips (CAS-571 hunk 1).
  await expect(page.locator("#mcDefs")).toHaveCount(1);
  await expect(page.locator("#mcFindGrad")).toHaveCount(1);
  await expect(page.locator("#mcWatchGrad")).toHaveCount(1);
  await expect(page.locator("#mcWatchMask")).toHaveCount(1);
});

test("CAS-571: both marks render at 20x20 CSS px, and the header row doesn't overlap the wordmark at 390px", async ({ page }) => {
  await toStreamListing(page);

  // The app applies its own accessibility zoom (html{zoom:var(--ui-scale)}) on top of every CSS px, so
  // boundingBox() (rendered/post-zoom) isn't the right measure of the AUTHORED 20x20 size — read computed
  // style instead, which reports the pre-zoom CSS value.
  const findSize = await page.locator("#agentsBtn .mcicon").evaluate(el => {
    const cs = getComputedStyle(el);
    return { w: parseFloat(cs.width), h: parseFloat(cs.height) };
  });
  expect(findSize.w).toBeCloseTo(20, 0);
  expect(findSize.h).toBeCloseTo(20, 0);

  const watchSize = await page.locator("#moviesBtn .mcicon").evaluate(el => {
    const cs = getComputedStyle(el);
    return { w: parseFloat(cs.width), h: parseFloat(cs.height) };
  });
  expect(watchSize.w).toBeCloseTo(20, 0);
  expect(watchSize.h).toBeCloseTo(20, 0);

  const brandRight = await page.locator(".brand").evaluate(el => el.getBoundingClientRect().right);
  const actionsLeft = await page.locator(".hdr-actions").evaluate(el => el.getBoundingClientRect().left);
  expect(actionsLeft).toBeGreaterThan(brandRight);

  await expect(page.locator(".brand")).toBeVisible();
  await expect(page.locator("#updated")).toBeVisible();
});

test("CAS-571: the old outline Find ring is gone from the app", async ({ page }) => {
  await toStreamListing(page);
  const oldRing = await page.evaluate(() =>
    document.documentElement.innerHTML.includes('stroke-dasharray="4 3.2"'));
  expect(oldRing).toBe(false);
});
