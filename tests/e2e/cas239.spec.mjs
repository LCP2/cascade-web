// CAS-239: the bottom of the card is where the decisions are — it never opens or closes it.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function firstCard(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-239: the availability strip does not expand the card", async ({ page }) => {
  const card = await firstCard(page);
  await expect(card).not.toHaveClass(/expanded/);

  const strip = card.locator(".bandw");
  await expect(strip).toBeVisible();
  await strip.click({ position: { x: 5, y: 5 } });
  await expect(card, "tapping the availability strip opened the card").not.toHaveClass(/expanded/);

  // …and it does not close it either, which is the same bug from the other side.
  await card.locator(".cbody").click({ position: { x: 5, y: 5 } });
  await expect(card).toHaveClass(/expanded/);
  await strip.click({ position: { x: 5, y: 5 } });
  await expect(card, "tapping the strip closed an open card").toHaveClass(/expanded/);
});

test("CAS-239: the footer and its controls do not expand the card", async ({ page }) => {
  const card = await firstCard(page);
  await expect(card).not.toHaveClass(/expanded/);

  // A miss between the two chips lands on the footer itself — the most likely real-world tap.
  await card.locator(".cfoot").click({ position: { x: 3, y: 3 } });
  await expect(card, "tapping the footer opened the card").not.toHaveClass(/expanded/);

  // …and using a control does its own job without opening anything.
  await card.locator(".ctl.watch").click();
  await expect(card.locator(".cpop")).toBeVisible();
  await expect(card, "opening the Watch panel expanded the card").not.toHaveClass(/expanded/);
  await page.keyboard.press("Escape");

  await card.locator(".ctl.notify").click();
  await expect(card.locator(".cpop.npop")).toBeVisible();
  await expect(card, "opening the Notify panel expanded the card").not.toHaveClass(/expanded/);
});

test("CAS-239: the card body still opens it", async ({ page }) => {
  const card = await firstCard(page);
  await card.locator(".title").click();
  await expect(card).toHaveClass(/expanded/);
  await card.locator(".title").click();
  await expect(card).not.toHaveClass(/expanded/);
});
