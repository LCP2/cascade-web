// CAS-304: the three card controls sit in one row, and each opens a direction-aware vertical popover —
// up by default, flipping down when the row doesn't have room above.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toCard(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-304: the three controls sit side by side on one row", async ({ page }) => {
  const card = await toCard(page);
  const boxes = await card.locator(".actions > .ctl").evaluateAll(els =>
    els.map(el => el.getBoundingClientRect()));
  expect(boxes.length).toBe(3);
  // A row: same top, increasing left-to-right. A stack would give each a different top and the same left.
  const tops = boxes.map(b => Math.round(b.top));
  expect(new Set(tops).size, "the three controls do not share a row").toBe(1);
  expect(boxes[1].left).toBeGreaterThan(boxes[0].left);
  expect(boxes[2].left).toBeGreaterThan(boxes[1].left);
});

test("CAS-304: a control's panel opens as a vertical column above the row by default", async ({ page }) => {
  const card = await toCard(page);
  await card.locator(".ctl.watch").click();
  const pop = card.locator(".cpop");
  await expect(pop).toBeVisible();
  await expect(pop, "opens up by default").not.toHaveClass(/pop-down/);
  const [popBox, actionsBox] = await Promise.all([
    pop.boundingBox(),
    card.locator(".actions").boundingBox(),
  ]);
  expect(popBox.y + popBox.height).toBeLessThanOrEqual(actionsBox.y + 1);
  const steps = await pop.locator(".csegs .cseg").evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
  const uniqueRows = new Set(steps.map(Math.round));
  expect(uniqueRows.size, "the options render as a vertical column").toBe(steps.length);
});

test("CAS-304: the panel flips below the row when there is no room above it", async ({ page }) => {
  const card = await toCard(page);
  // Pin the ACTIONS ROW itself flush with the viewport top — the card above it (poster, title, synopsis)
  // is tall, so scrolling the card to the top leaves plenty of room above the row; the row has to be the
  // thing pinned for "no room above" to be true.
  await card.locator(".actions").evaluate(el => el.scrollIntoView({ block: "start" }));
  // A real click here would let Playwright's own actionability scroll move the pinned row before it fires
  // (the row sits under the sticky header at this scroll position) — exactly the auto-scroll CAS-232's own
  // helpers avoid by driving openers directly, same as CAS-281's "only one panel open" test does.
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => openNotifyPanel(i, document.querySelector(`#card-${i} .ctl.notify`)), id);
  const pop = card.locator(".cpop");
  await expect(pop).toBeVisible();
  await expect(pop, "flips to open below when there is no room above").toHaveClass(/pop-down/);
  const [popBox, actionsBox] = await Promise.all([
    pop.boundingBox(),
    card.locator(".actions").boundingBox(),
  ]);
  expect(popBox.y).toBeGreaterThanOrEqual(actionsBox.y + actionsBox.height - 1);
});
