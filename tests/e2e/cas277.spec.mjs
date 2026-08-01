// CAS-277: the per-card user controls stack vertically.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator("#groups .card .actions").first()).toBeVisible();
}

test("CAS-277: the controls are stacked, not side by side", async ({ page }) => {
  await toAgentListing(page);
  const boxes = await page.evaluate(() => {
    const row = document.querySelector("#groups .card .actions");
    return [...row.children]
      .filter(el => !el.classList.contains("cpop"))
      .map(el => { const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, w: b.width }; });
  });
  expect(boxes.length, "there should be more than one control to stack").toBeGreaterThan(1);
  // Each control starts below the one before it — that is what vertical means.
  for(let i = 1; i < boxes.length; i++){
    expect(boxes[i].t, `control ${i} sits beside control ${i - 1}, not under it`)
      .toBeGreaterThanOrEqual(boxes[i - 1].b - 1);
  }
});

test("CAS-277: every control gets the full width of the column", async ({ page }) => {
  await toAgentListing(page);
  const { widths, rowWidth } = await page.evaluate(() => {
    const row = document.querySelector("#groups .card .actions");
    return {
      rowWidth: row.getBoundingClientRect().width,
      widths: [...row.children]
        .filter(el => !el.classList.contains("cpop"))
        .map(el => el.getBoundingClientRect().width),
    };
  });
  for(const w of widths){
    expect(Math.abs(w - rowWidth), `a control is ${w}px inside a ${rowWidth}px column`).toBeLessThan(2);
  }
});

test("CAS-277: they share one left edge", async ({ page }) => {
  await toAgentListing(page);
  const lefts = await page.evaluate(() => {
    const row = document.querySelector("#groups .card .actions");
    return [...row.children]
      .filter(el => !el.classList.contains("cpop"))
      .map(el => el.getBoundingClientRect().left);
  });
  expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(2);
});

test("CAS-277: the labels still read in full rather than being ellipsised", async ({ page }) => {
  await toAgentListing(page);
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll("#groups .card .actions .clab")]
      .filter(el => el.scrollWidth > el.clientWidth + 1).length);
  expect(clipped, "a control label is truncated — the point of stacking was to give it room").toBe(0);
});

test("CAS-277: both panels still open and anchor to the stack", async ({ page }) => {
  await toAgentListing(page);
  const card = page.locator("#groups .card").first();

  await card.locator(".ctl.watch").click();
  await expect(card.locator(".cpop")).toBeVisible();
  await expect(card.locator(".cpop .cseg").first()).toBeVisible();
  await card.locator(".cpop .cclose").click();
  await expect(card.locator(".cpop")).toHaveCount(0);

  await card.locator(".ctl.notify").click();
  await expect(card.locator(".cpop.npop")).toBeVisible();
});
