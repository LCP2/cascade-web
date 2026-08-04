// CAS-319: the Style step no longer prints a "Drawing from …" line under the genre chips.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

test("CAS-319: the genres step carries no ossumline / 'Drawing from' text", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);

  await page.evaluate(() => window.gotoStep("genres", "none"));
  await expect(page.locator(".osh", { hasText: "Style" })).toBeVisible();
  await expect(page.locator("#onbStep")).not.toContainText(/Drawing from/);
  expect(await page.locator("#onbStepSay").count(),
    "the genres step should render no #onbStepSay line at all").toBe(0);

  // The Style trail row (a different line, further down the flow) still summarises the genre pick —
  // this ticket removes the one line under the chips, not the running trail.
  await page.evaluate(() => window.gotoStep("language", "none"));
  const trail = await page.locator(".otrow", { has: page.locator(".otk", { hasText: "Style" }) }).first();
  await expect(trail).toBeVisible();
  await expect(trail).not.toContainText(/Drawing from/);
});
