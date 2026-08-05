// CAS-374: the Watch and Watched panels are content-width and edge-aligned under the chip that opens
// them, and that chip is now the panel's own toggle — no separate collapse chevron for either.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toFirstCard(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-374: the Watched chip opens a content-width panel hugging the card's right edge, and is its own toggle", async ({ page }) => {
  const card = await toFirstCard(page);
  const chip = card.locator(".ctl.watch");
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  await chip.click();
  const pop = card.locator(".cpop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".cclose")).toHaveCount(0);         // no separate collapse chevron any more
  await expect(chip).toHaveClass(/open/);
  await expect(chip).toHaveAttribute("aria-expanded", "true");

  const [popBox, actionsBox] = await Promise.all([
    pop.boundingBox(), card.locator(".actions").boundingBox(),
  ]);
  expect(popBox.width, "the Watched panel must be content-width, not the full row").toBeLessThan(actionsBox.width);
  expect(Math.abs((popBox.x + popBox.width) - (actionsBox.x + actionsBox.width)),
    "the Watched panel must hug the row's right edge").toBeLessThan(2);

  // Tapping the chip again is the only close gesture left, and it clears both the class and the ARIA state.
  await chip.click();
  await expect(card.locator(".cpop")).toHaveCount(0);
  await expect(chip).not.toHaveClass(/open/);
  await expect(chip).toHaveAttribute("aria-expanded", "false");
});

test("CAS-374: the Watch chip opens a content-width panel hugging the card's left edge, and is its own toggle", async ({ page }) => {
  const card = await toFirstCard(page);
  const chip = card.locator(".ctl.notify");
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  await chip.click();
  const pop = card.locator(".cpop.npop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".cclose")).toHaveCount(0);
  await expect(chip).toHaveClass(/open/);
  await expect(chip).toHaveAttribute("aria-expanded", "true");

  const [popBox, actionsBox] = await Promise.all([
    pop.boundingBox(), card.locator(".actions").boundingBox(),
  ]);
  expect(popBox.width, "the Watch panel must be content-width, not the full row").toBeLessThan(actionsBox.width);
  expect(Math.abs(popBox.x - actionsBox.x), "the Watch panel must hug the row's left edge").toBeLessThan(2);

  await chip.click();
  await expect(card.locator(".cpop")).toHaveCount(0);
  await expect(chip).not.toHaveClass(/open/);
  await expect(chip).toHaveAttribute("aria-expanded", "false");
});

test("CAS-374: opening one panel closes the other, exactly one open at a time", async ({ page }) => {
  const card = await toFirstCard(page);
  await card.locator(".ctl.watch").click();
  await expect(card.locator(".cpop")).toHaveCount(1);
  await expect(card.locator(".ctl.watch")).toHaveClass(/open/);

  // CAS-283: with a control open, the rest of the card — including its other chips — is a dismiss surface
  // first. The Watch chip's first tap here closes Watched rather than reaching its own handler; the second
  // tap is what actually opens Watch. Same two-tap pattern CAS-283's own spec asserts for the card body.
  const notifyChip = card.locator(".ctl.notify");
  await notifyChip.click();
  await expect(card.locator(".cpop")).toHaveCount(0);
  await expect(card.locator(".ctl.watch")).not.toHaveClass(/open/);

  await notifyChip.click();
  await expect(card.locator(".cpop.npop")).toBeVisible();
  await expect(card.locator(".cpop")).toHaveCount(1);
  await expect(card.locator(".ctl.watch")).not.toHaveClass(/open/);
  await expect(notifyChip).toHaveClass(/open/);
});

test("CAS-374: picking a Watched rating still works and shows the selected state", async ({ page }) => {
  const card = await toFirstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").filter({ hasText: "Watch Again" }).click();
  await expect.poll(() => page.evaluate(i => opinionOf(i), id)).toBe("liked");
});

test("CAS-374: picking a Watch level still works and shows the selected state", async ({ page }) => {
  const card = await toFirstCard(page, "stream");
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  const rent = pop.locator('.nopt[data-wk="rent"]');
  test.skip(!(await rent.count()) || (await rent.getAttribute("class") || "").includes("spent"),
    "this agent's first card has no live Rent level to pick");
  // A fresh streaming agent starts with Rent already switched on (CAS-243), so a plain "click -> true" would
  // be checking the default rather than the click — read the state and assert it flipped either way.
  const before = await rent.getAttribute("aria-pressed");
  await rent.click();
  await expect(rent, "picking the row must flip its pressed state").toHaveAttribute("aria-pressed", String(before !== "true"));
});

test("CAS-374: every row of the Watch panel is reachable without an inner scrollbar on an iPhone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const card = await toFirstCard(page, "stream");
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  await expect(pop).toBeVisible();
  const overflowing = await pop.locator(".nopts").evaluate(el => el.scrollHeight > el.clientHeight + 1);
  expect(overflowing, "the Watch panel's own list must not need to scroll internally").toBe(false);
});

test("CAS-374: the existing rating icons still render inside the Watched panel", async ({ page }) => {
  const card = await toFirstCard(page);
  await card.locator(".ctl.watch").click();
  const icons = card.locator(".cpop .cseg .ci svg");
  await expect(icons).toHaveCount(5);   // Wow! / Watch Again / Enjoyed / So-so / Disliked — CAS-278's ramp, unchanged
});
