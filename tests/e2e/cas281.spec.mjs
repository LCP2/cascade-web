// CAS-281: every card control collapses, by a button that says what it collapses.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

// CAS-349: the aria-labels follow the retaxonomy — `.ctl.watch` (the opinion panel) collapses "watched" now,
// `.ctl.notify` (the availability panel) collapses "watch". Still two distinct, honest names, one per control.
const CONTROLS = [
  { sel: ".ctl.watch",  name: "watched" },
  { sel: ".ctl.casc",   name: "cascade" },
  { sel: ".ctl.notify", name: "watch" },
];

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

for(const c of CONTROLS){
  test(`CAS-281: the ${c.name} control has a collapse button`, async ({ page }) => {
    const card = await toCard(page);
    await card.locator(c.sel).click();
    const close = card.locator(".cpop .cclose");
    await expect(close).toBeVisible();
    // It is named for what it collapses, not just "Close" — three panels open off one stack.
    await expect(close).toHaveAttribute("title", /collapse/i);
    await expect(close).toHaveAttribute("aria-label", new RegExp(`collapse ${c.name}`, "i"));
  });

  test(`CAS-281: the ${c.name} collapse button is a real target and actually collapses`, async ({ page }) => {
    const card = await toCard(page);
    await card.locator(c.sel).click();
    await expect(card.locator(".cpop")).toBeVisible();
    const box = await card.locator(".cpop .cclose").boundingBox();
    expect(box.width, "a collapse you cannot hit is not a collapse").toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
    await card.locator(".cpop .cclose").click();
    await expect(card.locator(".cpop")).toHaveCount(0);
  });
}

test("CAS-281: Escape collapses too, whichever control is open", async ({ page }) => {
  const card = await toCard(page);
  for(const c of CONTROLS){
    await card.locator(c.sel).click();
    await expect(card.locator(".cpop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.locator(".cpop")).toHaveCount(0);
  }
});

test("CAS-281: only one control is ever open at a time", async ({ page }) => {
  const card = await toCard(page);
  // The panel sits OVER the control stack, so the other chips are behind it and cannot be clicked while one
  // is open — which is exactly why each control needs its own collapse. Driving the openers directly is the
  // honest way to test the invariant without pretending the covered chips are reachable.
  await card.locator(".ctl.watch").click();
  await expect(card.locator(".cpop")).toHaveCount(1);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => openNotifyPanel(i, document.querySelector(`#card-${i} .ctl.notify`)), id);
  await expect(card.locator(".cpop"), "two panels open off one stack at once").toHaveCount(1);
  await expect(card.locator(".cpop.npop")).toBeVisible();
});

test("CAS-281: the collapse is needed because the panel covers card content above it", async ({ page }) => {
  // CAS-304: the panel now opens ABOVE the row rather than centred over it, so it no longer covers the
  // row's own sibling chips — but it still opens over the card content just above the row (poster,
  // synopsis, money row), which is exactly why the row still needs its own way to put the panel away.
  const card = await toCard(page);
  await card.locator(".ctl.watch").click();
  const covered = await page.evaluate(() => {
    const pop = document.querySelector("#groups .card .cpop").getBoundingClientRect();
    const card = document.querySelector("#groups .card");
    return [...card.querySelectorAll(".ctop *, .cfoot > *:not(.actions)")]
      .filter(el => { const b = el.getBoundingClientRect();
                      return b.width && b.height && b.top < pop.bottom && b.bottom > pop.top; }).length;
  });
  expect(covered, "if nothing were covered, the collapse would be optional").toBeGreaterThan(0);
});
