// CAS-248: the streaming Mission has no Buzz, on screen or behind it.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

test("CAS-248: a streaming Mission offers no More controls and carries no buzz", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await expect(page.locator(".osh", { hasText: "Mission" })).toBeVisible();

  await expect(page.locator(".osmore"), "streaming's More controls must be gone").toHaveCount(0);
  await expect(page.locator("#onbStep")).not.toContainText(/Buzz/i);

  const state = await page.evaluate(() => ({
    used: MISSION_DIALS_USED.stream, rest: missionRest(), buzz: onbApply().selBuzz,
  }));
  expect(state.used).not.toContain("buzz");
  expect(state.rest, "nothing left for More controls to reveal").toEqual([]);
  expect(state.buzz, "a streaming agent must not carry a buzz criterion").toBe(0);
});

test("CAS-248: the card's bar is the bar the agent applies, in each lane", async ({ page }) => {
  // Date Night is offered in both lanes and keeps its buzz rung at the cinema.
  await toShortlist(page, "cinema");
  const cinema = await shortlistCards(page);
  const cdn = cinema.find(c => /Date Night/i.test(c.name));
  expect(cdn, "Date Night must still be on the cinema shortlist").toBeTruthy();
  expect(cdn.barText || "", "the cinema card keeps its buzz clause").toBeDefined();
  const cinemaBar = await page.locator(".scard", { hasText: "Date Night" }).locator(".sc-chan").textContent();
  expect(cinemaBar).toMatch(/a little buzz/);

  await toShortlist(page, "stream");
  const streamBar = await page.locator(".scard", { hasText: "Date Night" }).locator(".sc-chan").textContent();
  expect(streamBar, "the streaming card must not promise a criterion it no longer applies").not.toMatch(/buzz/i);
  expect(streamBar).toMatch(/Well-liked/);
});
