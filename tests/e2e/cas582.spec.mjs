// CAS-582: the public About page — a "what is this?" answer reachable from the splash without an
// account, plus the splash tagline drops to "Movies". Drives the real splash → About → Close/Escape
// gesture, the same way a visitor with no account ever could reach it.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-582: splash offers a quiet About door and the tagline reads Movies", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splashTag")).toHaveText("Movies");
  await expect(page.locator("#splashAbout")).toBeVisible();
  await expect(page.locator("#splashAbout")).toHaveText("What is Cascade?");
});

test("CAS-582: About opens over the splash, Close returns to an unchanged splash", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashAbout").click();
  await expect(page.locator("#aboutPage")).toHaveClass(/open/);

  await page.locator("#aboutClose").click();
  await expect(page.locator("#aboutPage")).not.toHaveClass(/open/);
  await expect(page.locator("#splashTag")).toHaveText("Movies");
  await expect(page.locator("#splashCta")).toBeVisible();
});

test("CAS-582: Escape closes About and returns to the splash", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashAbout").click();
  await expect(page.locator("#aboutPage")).toHaveClass(/open/);

  await page.keyboard.press("Escape");
  await expect(page.locator("#aboutPage")).not.toHaveClass(/open/);
  await expect(page.locator("#splashCta")).toBeVisible();
});

test("CAS-582: the catalogue count renders as a formatted number", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashAbout").click();

  const countText = await page.locator("#aboutCount").textContent();
  const movieCount = await page.evaluate(() => MOVIES.length);
  expect(countText.trim()).toBe(movieCount.toLocaleString("en-AU"));
  expect(countText.trim()).not.toBe("0");
});

test("CAS-582: the existing in-app TMDB/Watchmode/JustWatch credit block is untouched", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#appCredit")).toHaveCount(1);
});
