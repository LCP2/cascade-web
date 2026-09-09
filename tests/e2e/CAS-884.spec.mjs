// CAS-884: Recommend Cascade — the send half of M11 (Refer a friend). Signed-in only, reached
// from the nav menu; Cascade itself sends the email on a new hourly workflow, so this sheet only
// ever inserts a row into public.recommendations. Uses CAS-883's direct window.CascadeAuth
// mutation technique (see that spec's own comment) rather than a fake-config/fake-supabase-js
// network route: recommendSend's onclick reads window.CascadeAuth synchronously, so a client
// that exists before the listing renders is all that's needed here too.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

async function primeFakeAccount(page){
  await page.evaluate(() => {
    window.__recommendInserts = [];
    window.__recommendShouldFail = false;
    window.CascadeAuth.enabled = true;
    window.CascadeAuth.status = "signed-in";
    window.CascadeAuth.user = { id: "cas884-user", email: "lee@example.com" };
    window.CascadeAuth.session = { user: { id: "cas884-user" } };
    window.CascadeAuth.client = { from: (table) => ({
      insert: (rows) => {
        if(table !== "recommendations") return Promise.resolve({ data: [], error: null });
        if(window.__recommendShouldFail) return Promise.resolve({ data: null, error: { message: "insert failed" } });
        window.__recommendInserts.push(...rows);
        return Promise.resolve({ data: rows, error: null });
      },
    }) };
  });
}

/** Signed in (faked, see primeFakeAccount), landed on the listing with the nav menu reachable. */
async function signedInListing(page){
  await toShortlist(page, "cinema");
  await primeFakeAccount(page);
  await finishFlow(page);
  await toListing(page);
}

async function openRecommendSheet(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Recommend Cascade" }).click();
  await expect(page.locator("#recommend")).toHaveClass(/open/);
}

// AC6a: the nav menu contains Recommend Cascade, and opening it opens the sheet.
test("CAS-884 AC6a: the nav menu contains Recommend Cascade, and opening it opens the sheet", async ({ page }) => {
  await signedInListing(page);
  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#navMenu .navitem", { hasText: "Recommend Cascade" })).toBeVisible();
  await page.locator("#navMenu .navitem", { hasText: "Recommend Cascade" }).click();
  await expect(page.locator("#recommend")).toHaveClass(/open/);
});

// AC6b: opening it shows a pre-filled intro message.
test("CAS-884 AC6b: opening the sheet shows a pre-filled intro", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);
  const value = await page.locator("#recommendMsg").inputValue();
  expect(value.length).toBeGreaterThan(0);
  expect(value).toContain("Cascade");
});

// AC6c: typing a name updates the greeting in the message.
test("CAS-884 AC6c: typing a name updates the greeting in the message", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);
  await page.locator("#recommendName").fill("Priya");
  await expect(page.locator("#recommendMsg")).toHaveValue(/^Hi Priya/);
});

// AC6d: sending performs exactly one insert into recommendations.
test("CAS-884 AC6d: sending performs exactly one insert into recommendations", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);
  await page.locator("#recommendName").fill("Priya");
  await page.locator("#recommendEmail").fill("priya@example.com");
  await page.locator("#recommendSend").click();
  await page.waitForFunction(() => window.__recommendInserts.length > 0, null, { timeout: 5000 });

  const rows = await page.evaluate(() => window.__recommendInserts);
  expect(rows.length).toBe(1);
  expect(rows[0].to_name).toBe("Priya");
  expect(rows[0].to_email).toBe("priya@example.com");
  expect(rows[0].message).toContain("Priya");
});

// AC6e: an invalid email blocks the insert and shows a reason.
test("CAS-884 AC6e: an invalid email blocks the insert and shows a reason", async ({ page }) => {
  await signedInListing(page);
  await openRecommendSheet(page);
  await page.locator("#recommendName").fill("Priya");
  await page.locator("#recommendEmail").fill("not-an-email");
  await page.locator("#recommendSend").click();

  await expect(page.locator("#recommendErr")).toBeVisible();
  const rows = await page.evaluate(() => window.__recommendInserts);
  expect(rows.length).toBe(0);
});
