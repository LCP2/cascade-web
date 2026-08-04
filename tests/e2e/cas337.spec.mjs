// CAS-337: onboarding/settings header reflow. The back button, page title and step counter now share a
// single row, with progress reduced to a hairline directly beneath it — the standalone title row a step
// used to draw inside its own sliding pane is gone, on both the fixed wizard header and the hub screens'
// own .ostop row.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

test("CAS-337: a chromed wizard step's header is one row — back, title, step counter — with a hairline below it", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("genres", "none"));
  await expect(page.locator("#stepHdr")).toBeVisible();

  const row = page.locator("#stepHdr .steprow");
  await expect(row.locator(".osback")).toBeVisible();
  await expect(row.locator("#stepTitle")).toHaveText("Style");
  await expect(row.locator("#stepLbl")).toHaveText(/^Step \d+ of \d+$/);

  const structure = await page.evaluate(() => [...document.getElementById("stepHdr").children].map(c => c.className));
  expect(structure).toEqual(["steprow", "stepprog"]);

  // the step's own body no longer draws a title inside the sliding pane — the header owns it now
  await expect(page.locator("#onbStepInner > h2.osh")).toHaveCount(0);
});

test("CAS-337: the step counter and title update together when the wizard advances", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await expect(page.locator("#stepHdr #stepTitle")).toHaveText("Mission");
  expect(await page.locator("#stepHdr #stepLbl").textContent()).toBe("Step 1 of 7");

  await page.evaluate(() => window.gotoStep("genres", "none"));
  await expect(page.locator("#stepHdr #stepTitle")).toHaveText("Style");
  expect(await page.locator("#stepHdr #stepLbl").textContent()).toBe("Step 3 of 7");
});

test("CAS-337: a non-chromed hub step (Pick a Cascade Agent) keeps back button and title on one row inside the pane", async ({ page }) => {
  await toShortlist(page, "stream");
  await expect(page.locator("#stepHdr")).toBeHidden();

  const ostop = page.locator("#onbStepInner .ostop");
  await expect(ostop.locator(".osback")).toBeVisible();
  await expect(ostop.locator(".osh", { hasText: "Pick a Cascade Agent" })).toBeVisible();
});

test("CAS-337: the Edit Agent screen also puts its title on the back-button row, not a row of its own", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("briefing", "none"));
  await expect(page.locator("#stepHdr")).toBeHidden();

  const ostop = page.locator("#onbStepInner .ostop");
  await expect(ostop.locator(".osback")).toBeVisible();
  await expect(ostop.locator(".osh", { hasText: "Edit Agent" })).toBeVisible();
});
