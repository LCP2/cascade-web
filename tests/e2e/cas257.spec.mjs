// CAS-257: the splash says what Cascade IS, directly under its name.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-257: the tagline reads 'Movie AI Agents'", async ({ page }) => {
  await freshApp(page);
  const tag = page.locator("#splashTag");
  await expect(tag).toBeVisible();
  await expect(tag).toHaveText("Movie AI Agents");
});

test("CAS-257: it sits directly under the wordmark, above everything else", async ({ page }) => {
  await freshApp(page);
  const word = await page.locator(".splashword").boundingBox();
  const tag = await page.locator("#splashTag").boundingBox();
  const loz = await page.locator(".splashloz").boundingBox();

  expect(tag.y, "the tagline is not below the wordmark").toBeGreaterThan(word.y);
  expect(tag.y, "the tagline has drifted away from the wordmark").toBeLessThan(word.y + word.height + 24);
  expect(loz.y, "the lozenges no longer follow the tagline").toBeGreaterThan(tag.y + tag.height - 1);

  // Same optical centre as the wordmark it subtitles.
  const centre = b => b.x + b.width / 2;
  expect(Math.abs(centre(tag) - centre(word))).toBeLessThan(6);
});

test("CAS-257: the extra line did not push the splash off a 390x844 phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freshApp(page);
  await expect(page.locator("#splashTag")).toBeVisible();
  const cta = await page.locator("#splashLogin").boundingBox();
  expect(cta.y + cta.height, "the log-in door is below the fold").toBeLessThanOrEqual(844);
});
