// CAS-259: the splash's primary door is labelled just "Sign up".
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-259: the primary button reads 'Sign up' and nothing more", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splashCta")).toHaveText("Sign up");
});

test("CAS-259: the two doors are the same grammar, and it still opens the flow", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splashLogin")).toHaveText("Log in");
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
});
