// CAS-309: the "What I've been doing for you" intro panel is gone from the top of the cascade.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function agentListing(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-309: the intro panel no longer renders", async ({ page }) => {
  await agentListing(page);
  await expect(page.locator("#listSaid")).not.toContainText("What I've been doing for you");
  await expect(page.locator("#listSaid .dgcard")).toHaveCount(0);
  const stillDefined = await page.evaluate(() => typeof foundValueHTML === "function");
  expect(stillDefined).toBe(false);
});

test("CAS-309: the layout closes the gap cleanly — no empty leading block", async ({ page }) => {
  await agentListing(page);
  const firstChildIsEmpty = await page.evaluate(() => {
    const el = document.getElementById("listSaid");
    const first = el.firstElementChild;
    return !!first && first.textContent.trim() === "" && !first.classList.contains("mlgroup");
  });
  expect(firstChildIsEmpty).toBe(false);
});
