// CAS-320: the onboarding setup summary no longer prints a "Watching" row.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

test("CAS-320: the setup trail carries no Watching row, but keeps its other rows", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);

  // pickCard lands on Mission (selectivity), which is where the trail first appears — it recaps every
  // step walked so far, including the priority answer this ticket's row used to summarise.
  await expect(page.locator("#onbTrail")).toBeVisible();
  expect(await page.locator(".otrow", { has: page.locator(".otk", { hasText: "Watching" }) }).count(),
    "the trail should render no Watching row at all").toBe(0);

  // The trail itself survives for the steps that still have something to recap.
  await expect(page.locator(".otrow", { has: page.locator(".otk", { hasText: "Agent" }) })).toBeVisible();
});
