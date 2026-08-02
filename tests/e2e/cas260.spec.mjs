// CAS-260: a step that has slid in is finished — it does not then fade up from 10px below.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

/** Click the splash CTA, answer the priority question, and land on the shortlist — one real slide. */
async function slideOnce(page){
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(".priobtn.cin").click();
  await expect(page.locator(".scard").first()).toBeVisible();
}

test("CAS-260: the settled pane is not running an entry animation", async ({ page }) => {
  await slideOnce(page);
  // Let the slide and its cleanup finish.
  await page.waitForTimeout(700);
  const anim = await page.locator("#onbStepInner").evaluate(el => ({
    name: getComputedStyle(el).animationName,
    transform: getComputedStyle(el).transform,
    opacity: getComputedStyle(el).opacity,
  }));
  expect(anim.name, "the slid-in pane re-runs splashIn once the slide classes come off").not.toBe("splashIn");
  expect(anim.transform === "none" || anim.transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  expect(Number(anim.opacity)).toBe(1);
});

test("CAS-260: nothing moves after the slide ends", async ({ page }) => {
  await slideOnce(page);
  // Sample the heading's position across the window where the old splashIn re-run used to happen.
  const tops = await page.evaluate(async () => {
    const at = () => {
      const h = document.querySelector("#onbStepInner .osh") || document.querySelector("#onbStepInner");
      return Math.round(h.getBoundingClientRect().top * 10) / 10;
    };
    const seen = [];
    // The slide is ~460ms; start once it is over and watch the next 500ms.
    await new Promise(r => setTimeout(r, 520));
    for(let i = 0; i < 20; i++){
      seen.push(at());
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 25)));
    }
    return seen;
  });
  const moved = Math.max(...tops) - Math.min(...tops);
  expect(moved, `the step drifted ${moved}px after it had settled: ${tops.join(",")}`).toBeLessThanOrEqual(0.5);
});

test("CAS-260: the slide itself still happens", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  const moving = page.evaluate(() => new Promise(res => {
    // Catch the incoming pane mid-slide: it should be off to the right of where it lands.
    setTimeout(() => {
      const pane = document.getElementById("onbStepInner");
      res(pane ? getComputedStyle(pane).transform : null);
    }, 90);
  }));
  await page.locator(".priobtn.cin").click();
  const t = await moving;
  expect(t, "the pane is not transformed at all mid-transition — the slide is gone").not.toBe("none");
});
