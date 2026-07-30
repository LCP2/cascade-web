// CAS-247: the streaming shortlist leads with the preset it recommends.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards } from "./helpers.mjs";

test("CAS-247: Everyday Favourites is the first streaming choice, and carries the badge", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  expect(cards[0].name).toMatch(/Everyday Favourites/);
  // The badge and the position must be on the same card, or the screen is recommending one and leading with
  // another — which is the whole of the report.
  const first = page.locator(".scard").first();
  await expect(first).toContainText(/RECOMMENDED/);
  await expect(first).toContainText(/Everyday Favourites/);

  // The rest keep their written order under it.
  expect(cards.slice(1).map(c => c.name).join(" | "))
    .toMatch(/Loved & Acclaimed.*Date Night.*Nominees & Awards.*Totally Custom/);
});

test("CAS-247: cinema still leads with its own recommendation", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  expect(cards[0].name).toMatch(/Blockbusters/);
  await expect(page.locator(".scard").first()).toContainText(/RECOMMENDED/);
});
