// CAS-367: the "Any" detent (the track's own leftmost stop) must be a real, draggable destination —
// not just a click target on its label. See tests/e2e/cas340.spec.mjs for the label-click coverage this
// adds a drag-to-the-edge counterpart for.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, ctaLocator } from "./helpers.mjs";

async function toYearsStep(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  // Mission -> Name -> Style -> Ratings -> How far back
  for(let i = 0; i < 4; i++){
    await ctaLocator(page).click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator(".osh", { hasText: "How far back?" })).toBeVisible();
}

test("CAS-367: dragging the handle to the track's left edge lands on Any, not 50", async ({ page }) => {
  await toYearsStep(page);
  const input = page.locator("#onbStepYears");
  const box = await input.boundingBox();
  const startVal = Number(await input.inputValue());
  const startX = box.x + (startVal / 100) * box.width;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Overshoot past the visible track, the way a real swipe toward the edge of the screen does.
  await page.mouse.move(startX - box.width / 2, startY, { steps: 6 });
  await page.mouse.move(box.x - 40, startY, { steps: 10 });
  await page.mouse.up();

  expect(await input.inputValue()).toBe("0");
  expect(await page.evaluate(() => onbFlow.draft.yearsBack)).toBe(0);
  expect((await page.locator("#onbStepYearExplain").textContent()).trim()).toBe("All years");
  await expect(page.locator("#onbStepYearLabels .ysnap", { hasText: "Any" })).toHaveClass(/lit/);
});
