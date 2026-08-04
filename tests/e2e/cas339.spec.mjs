// CAS-339: the streaming onboarding lane walks its seven counted steps in order — Mission, Agent Name,
// Style, Ratings, How far back, My Services, Notify — and "Cascade Agents keep finding" is shown between
// My Services and Notify without being one of the seven: it carries no Step-N-of-M number of its own.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, ctaLocator } from "./helpers.mjs";

const STREAM_COUNTED = [
  ["selectivity",    "Mission"],
  ["name",           "Name your Agent"],
  ["genres",         "Style"],
  ["age",            "Ratings"],
  ["years",          "How far back?"],
  ["services",       "My services"],
  ["notifysettings", "How will your agent notify you about Movies?"],
];

test("CAS-339: FLOWS.stream holds the seven steps in the ticket's order, plus keep-finding uncounted", async ({ page }) => {
  await toShortlist(page, "stream");
  const list = await page.evaluate(() => FLOWS.stream);
  expect(list).toEqual(["priority", "pickagent",
    ...STREAM_COUNTED.slice(0, 6).map(([k]) => k), "keepfinding", "notifysettings"]);
});

test("CAS-339: walking the streaming flow counts exactly its seven steps, in order", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);

  for(let i = 0; i < STREAM_COUNTED.length; i++){
    const [key, heading] = STREAM_COUNTED[i];
    expect(await page.evaluate(() => onbStepKey), `expected ${key} at position ${i}`).toBe(key);
    await expect(page.locator(".osh", { hasText: heading })).toBeVisible();
    await expect(page.locator("#stepHdr")).toBeVisible();
    expect(await page.locator("#stepLbl").textContent()).toBe(`Step ${i + 1} of 7`);

    await ctaLocator(page).click();
    await page.waitForTimeout(120);
    if(key === "services"){
      // The next screen is "keep finding" — walked, but not counted: it gets its own chrome, not the fixed
      // header, and the meter must not have moved off "Step 6 of 7" while it's showing.
      expect(await page.evaluate(() => onbStepKey)).toBe("keepfinding");
      await expect(page.locator(".osh", { hasText: "Cascade Agents keep finding" })).toBeVisible();
      await expect(page.locator("#stepHdr")).toBeHidden();
      await ctaLocator(page).click();
      await page.waitForTimeout(120);
    }
  }
  expect(await page.evaluate(() => onbStepKey)).toBe("notifysettings");
});

test("CAS-339: the cinema flow's five counted steps never include keep-finding either", async ({ page }) => {
  await toShortlist(page, "cinema");
  const counted = await page.evaluate(() => flowCounted());
  expect(counted).not.toContain("keepfinding");
  expect(counted.length).toBe(5);
});
