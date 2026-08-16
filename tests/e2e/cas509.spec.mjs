// CAS-509: on a notched iPhone the header (CAS-459) clears the status bar with its own
// calc(12px + env(safe-area-inset-top,0px)) padding, but every secondary full-screen view used a flat top
// padding with no safe-area term — their back/close controls sat flush under the notch. Two different
// screen shells needed two different fixes:
//   - .stephdr/.steprow — the FIXED chrome the linear first-run onboarding steps use (flowOn === true,
//     e.g. straight after picking a starter agent). Gets its own copy of the header's exact formula.
//   - .sharpstep's own frame padding — used whenever that chrome ISN'T showing (flowOn false): the Edit
//     Agent hub and its Briefing spokes draw their back button inline, as the first thing inside the frame,
//     with no fixed header floating above it to clear instead.
// Plus the shared .uscreen shell (Agents, Your Movies, Review, Account, Service analysis, Lists, About) and
// the notifications drawer, both fixed from the viewport's true top:0.
//
// This suite's default viewport (playwright.config.mjs) is plain desktop Chrome at phone width, where
// env(safe-area-inset-top) is always 0 — so nothing here would ever exercise the bug without actually
// simulating a notch. Chromium's Emulation.setSafeAreaInsetsOverride CDP call is what DevTools' own device
// toolbar uses for the same job, so it's used here via a raw CDP session rather than any Playwright device
// preset (Playwright's own iPhone device descriptors change the viewport/UA, not this).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

const NOTCH_TOP = 59;   // iPhone 15 Pro's own safe-area-inset-top, in CSS px

async function setNotch(page, top){
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top, topMax: top, left: 0, leftMax: 0, right: 0, rightMax: 0, bottom: 0, bottomMax: 0 },
  });
}

const padTop = loc => loc.evaluate(el => parseFloat(getComputedStyle(el).paddingTop));

/** One real agent, landed on its listing — what the Agents/Your Movies/drawer cases all need. */
async function withOneAgent(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-509: without a notch, nothing here changed — the header keeps its exact CAS-459 padding", async ({ page }) => {
  await withOneAgent(page);
  expect(await padTop(page.locator("header"))).toBe(12);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  expect(await padTop(page.locator(".uwrap").first())).toBe(22);
});

test("CAS-509: onboarding's own fixed chrome (.stephdr) gains the same clearance delta as the header", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  const headerPad0 = await padTop(page.locator("header"));

  await pickCard(page, cards[0].name);
  // Straight after picking a starter agent, the flow is on a real, wired (flowOn===true) sharpening step —
  // its progress-tracked chrome, not a ?step= preview (previews deliberately never show it).
  await expect(page.locator("#stepHdr")).toBeVisible();

  await setNotch(page, NOTCH_TOP);
  const headerPad1 = await padTop(page.locator("header"));
  const steprowPad1 = await padTop(page.locator(".steprow"));
  expect(headerPad1 - headerPad0).toBe(NOTCH_TOP);          // AC4: the header's own baseline is untouched
  expect(steprowPad1).toBe(headerPad1);                     // AC1/AC3: literally the same top inset

  const backBox = await page.locator(".steprow .osback").boundingBox();
  expect(backBox.y).toBeGreaterThanOrEqual(NOTCH_TOP);

  // The fixed header grew taller by the inset — its content offset (.sharpstep.chromed .osinner, a flat
  // 60px that only ever has to clear THIS fixed header) still has to clear it, or the header now overlaps
  // the first row of content. #onbStepInner's OWN box starts where .sharpstep's padding puts it — its
  // padding-top only pushes its children, so the check is against its first rendered child, not itself.
  const hdr = await page.locator("#stepHdr").boundingBox();
  const contentTop = (await page.locator("#onbStepInner > *").first().boundingBox()).y;
  expect(contentTop).toBeGreaterThanOrEqual(hdr.y + hdr.height - 1);
});

test("CAS-509: Edit Agent's own inline back row (the hub, never chromed) gains the same clearance delta as the header", async ({ page }) => {
  await withOneAgent(page);
  const headerPad0 = await padTop(page.locator("header"));

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(".agrow .ag-edit").first().click();
  await expect(page.locator(".osh", { hasText: "Edit Agent" })).toBeVisible();
  // The hub draws its own back row inline (briefOn, not flowOn) — the fixed onboarding chrome never shows.
  await expect(page.locator("#stepHdr")).toBeHidden();
  const framePad0 = await padTop(page.locator("#onbStep"));

  await setNotch(page, NOTCH_TOP);
  const headerPad1 = await padTop(page.locator("header"));
  const framePad1 = await padTop(page.locator("#onbStep"));
  expect(headerPad1 - headerPad0).toBe(NOTCH_TOP);
  expect(framePad1 - framePad0).toBe(NOTCH_TOP);            // AC1: same allowance added as the main screen got

  const backBox = await page.locator("#onbStepInner .ostop .osback").boundingBox();
  expect(backBox.y).toBeGreaterThanOrEqual(NOTCH_TOP);
});

test("CAS-509: on a notched viewport, the Agents screen's back button gains the same clearance delta as the header", async ({ page }) => {
  await withOneAgent(page);
  const headerPad0 = await padTop(page.locator("header"));

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  const uwrapPad0 = await padTop(page.locator("#agentsScreen .uwrap"));

  await setNotch(page, NOTCH_TOP);
  const headerPad1 = await padTop(page.locator("header"));
  const uwrapPad1 = await padTop(page.locator("#agentsScreen .uwrap"));
  expect(headerPad1 - headerPad0).toBe(NOTCH_TOP);
  expect(uwrapPad1 - uwrapPad0).toBe(NOTCH_TOP);

  const backBox = await page.locator("#agentsScreen .ostop .osback").boundingBox();
  expect(backBox.y).toBeGreaterThanOrEqual(NOTCH_TOP);
});

test("CAS-509: the rest of the sweep — Your Movies and the notifications drawer — get the same clearance delta too", async ({ page }) => {
  await withOneAgent(page);
  const headerPad0 = await padTop(page.locator("header"));

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies")).toHaveClass(/open/);
  const ymPad0 = await padTop(page.locator("#yourMovies .uwrap"));

  // CAS-539 dropped Your Movies' own back arrow — closing now goes through the header's Agents chip,
  // the established CAS-534 convention for leaving Your Movies.
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#yourMovies")).not.toHaveClass(/open/);

  await page.locator("#bell").click();
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  const dheadPad0 = await padTop(page.locator(".dhead"));

  await setNotch(page, NOTCH_TOP);
  const headerPad1 = await padTop(page.locator("header"));
  expect(headerPad1 - headerPad0).toBe(NOTCH_TOP);

  const dheadPad1 = await padTop(page.locator(".dhead"));
  expect(dheadPad1 - dheadPad0).toBe(NOTCH_TOP);

  await page.locator("#closeDrawer").click();
  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies")).toHaveClass(/open/);
  const ymPad1 = await padTop(page.locator("#yourMovies .uwrap"));
  expect(ymPad1 - ymPad0).toBe(NOTCH_TOP);
});
