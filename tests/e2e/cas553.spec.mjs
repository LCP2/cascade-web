// CAS-553: on-device diagnostics panel — build stamp, viewport/safe-area metrics, console + error
// tail, copy to clipboard. Opened by five taps on the About screen's build line (the only path the
// installed iOS app has, since it has no address bar), or by ?diag on the web build.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

async function openAbout(page){
  await page.evaluate(() => window.openAbout());
  await expect(page.locator("#aboutScreen")).toHaveClass(/open/);
  await expect(page.locator("#aboutBuild")).toBeVisible();
}

test("CAS-553: five taps on the About screen's build line opens the diagnostics panel", async ({ page }) => {
  await freshApp(page);
  await openAbout(page);

  const buildLine = page.locator("#aboutBuild");
  for(let i = 0; i < 5; i++) await buildLine.click();

  await expect(page.locator("#diagOverlay")).toHaveClass(/open/);
  await expect(page.locator("#diagPanel")).toBeVisible();
});

test("CAS-553: fewer than five taps does not open the panel", async ({ page }) => {
  await freshApp(page);
  await openAbout(page);

  const buildLine = page.locator("#aboutBuild");
  for(let i = 0; i < 4; i++) await buildLine.click();

  await expect(page.locator("#diagOverlay")).not.toHaveClass(/open/);
});

test("CAS-553: ?diag opens the diagnostics panel on the web build", async ({ page }) => {
  await freshApp(page);
  await page.goto("/index.html?diag=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#diagOverlay")).toHaveClass(/open/, { timeout: 5000 });
});

test("CAS-553: the ?diag sessionStorage flag reopens the panel across an in-session reload", async ({ page }) => {
  await freshApp(page);
  await page.goto("/index.html?diag=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#diagOverlay")).toHaveClass(/open/);

  await page.locator("#diagClose").click();
  await expect(page.locator("#diagOverlay")).not.toHaveClass(/open/);

  // A plain reload with no ?diag in the URL — the sessionStorage flag set by the earlier ?diag load
  // is what has to bring it back, not the query param (which is gone).
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#diagOverlay")).toHaveClass(/open/, { timeout: 5000 });
});

test("CAS-553: the panel shows identity and geometry fields", async ({ page }) => {
  await freshApp(page);
  await openAbout(page);
  await page.evaluate(() => window.openDiagPanel());

  const body = page.locator("#diagBody");
  for(const label of ["Version", "Build", "Commit", "Built at", "Protocol", "Origin",
                       "Capacitor bridge", "User agent", "innerWidth", "visualViewport",
                       "documentElement", "safe-area-inset", "devicePixelRatio", "orientation",
                       "Log tail"]){
    await expect(body).toContainText(label);
  }
});

test("CAS-553: an error thrown at runtime is captured in the log tail", async ({ page }) => {
  await freshApp(page);
  page.on("pageerror", () => {});   // the throw below is deliberate — don't fail the test on it

  await page.evaluate(() => {
    setTimeout(() => { throw new Error("CAS-553 test error"); }, 0);
  });
  await page.waitForFunction(() =>
    diagLog.some(e => e.kind === "onerror" && e.msg.includes("CAS-553 test error")));

  await openAbout(page);
  await page.evaluate(() => window.openDiagPanel());
  await expect(page.locator("#diagBody")).toContainText("CAS-553 test error");
});

test("CAS-553: console.warn and console.error land in the log tail, and still print to the console", async ({ page }) => {
  await freshApp(page);
  const consoleMsgs = [];
  page.on("console", msg => consoleMsgs.push(msg.text()));

  await page.evaluate(() => {
    console.warn("CAS-553 warn probe");
    console.error("CAS-553 error probe");
  });
  await page.waitForFunction(() => diagLog.some(e => e.msg.includes("CAS-553 warn probe")));

  expect(consoleMsgs.some(t => t.includes("CAS-553 warn probe"))).toBe(true);
  expect(consoleMsgs.some(t => t.includes("CAS-553 error probe"))).toBe(true);

  await openAbout(page);
  await page.evaluate(() => window.openDiagPanel());
  await expect(page.locator("#diagBody")).toContainText("CAS-553 warn probe");
  await expect(page.locator("#diagBody")).toContainText("CAS-553 error probe");
});

test("CAS-553: the copy button puts the full report on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshApp(page);
  await openAbout(page);
  await page.evaluate(() => window.openDiagPanel());

  await page.locator("#diagCopy").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("=== Cascade diagnostics ===");
  expect(clip).toContain("-- Identity --");
  expect(clip).toContain("-- Geometry --");
  expect(clip).toContain("-- Log tail");
});

test("CAS-553: an outside tap on the dimmed backdrop closes the panel", async ({ page }) => {
  await freshApp(page);
  await openAbout(page);
  await page.evaluate(() => window.openDiagPanel());
  await expect(page.locator("#diagOverlay")).toHaveClass(/open/);

  await page.locator("#diagOverlay").click({ position: { x: 5, y: 5 } });

  await expect(page.locator("#diagOverlay")).not.toHaveClass(/open/);
});

test("CAS-553: a tap inside the panel does not close it", async ({ page }) => {
  await freshApp(page);
  await openAbout(page);
  await page.evaluate(() => window.openDiagPanel());

  await page.locator("#diagBody").click();

  await expect(page.locator("#diagOverlay")).toHaveClass(/open/);
});

test("CAS-553: Escape closes the panel", async ({ page }) => {
  await freshApp(page);
  await openAbout(page);
  await page.evaluate(() => window.openDiagPanel());

  await page.keyboard.press("Escape");

  await expect(page.locator("#diagOverlay")).not.toHaveClass(/open/);
});

test("CAS-553: no visible entry point exists for someone who doesn't know the gesture", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#diagOverlay")).not.toHaveClass(/open/);

  const visibleText = await page.locator("body").innerText();
  expect(visibleText.toLowerCase()).not.toContain("diagnostics");
});
