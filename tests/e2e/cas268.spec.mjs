// CAS-268: an agent can be deleted from the screen you edit it on — after you say so.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function buildAgent(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

const deckCount = page => page.evaluate(() => cascades.length);
const openEdit = async page => {
  await page.evaluate(() => window.editCascade());
  await expect(page.locator("#onbStepInner .osdoor").first()).toBeVisible();
};

test("CAS-268: the Edit Agent page offers Delete", async ({ page }) => {
  await buildAgent(page);
  await openEdit(page);
  const del = page.locator("#onbStepInner .osdel");
  await expect(del).toBeVisible();
  await expect(del).toHaveText("Delete agent");
  // It is not the primary action, and it is under it.
  const [save, box] = await Promise.all([
    page.locator("#onbStepInner .oscta").boundingBox(),
    del.boundingBox(),
  ]);
  expect(box.y, "Delete sits above Save").toBeGreaterThan(save.y);
  expect(box.height, "Delete is too small to hit reliably").toBeGreaterThanOrEqual(40);
});

test("CAS-268: Cancel keeps the agent", async ({ page }) => {
  await buildAgent(page);
  const before = await deckCount(page);
  await openEdit(page);

  page.on("dialog", d => d.dismiss());          // the Cancel half of the confirmation
  await page.locator("#onbStepInner .osdel").click();
  await page.waitForTimeout(300);

  expect(await deckCount(page), "Cancel deleted the agent anyway").toBe(before);
  await expect(page.locator("#onbStepInner .osdel"), "the screen closed on Cancel").toBeVisible();
});

test("CAS-268: OK deletes it, and the screen closes", async ({ page }) => {
  await buildAgent(page);
  const before = await deckCount(page);
  const name = await page.evaluate(() => activeCascade().name);
  await openEdit(page);

  const asked = [];
  page.on("dialog", d => { asked.push(d.message()); d.accept(); });   // the OK half
  await page.locator("#onbStepInner .osdel").click();
  await page.waitForTimeout(400);

  expect(asked.length, "it deleted without asking").toBe(1);
  expect(asked[0], "the confirmation does not name the agent").toContain(name);
  expect(await deckCount(page), "the agent is still on the deck").toBe(before - 1);
  expect(await page.evaluate(() => cascades.some(c => c.name === name))).toBe(false);
  await expect(page.locator("#onbStep.open")).toHaveCount(0);
});

test("CAS-268: it survives a reload — the deck on disk really changed", async ({ page }) => {
  await buildAgent(page);
  const name = await page.evaluate(() => activeCascade().name);
  await openEdit(page);
  page.on("dialog", d => d.accept());
  await page.locator("#onbStepInner .osdel").click();
  await page.waitForTimeout(400);

  await page.reload();
  await page.waitForFunction(() => Array.isArray(MOVIES));
  expect(await page.evaluate(() => cascades.some(c => c.name === name))).toBe(false);
});

test("CAS-268: an agent that has never been saved is not offered a Delete", async ({ page }) => {
  await buildAgent(page);
  // New Cascade → priority → pick an agent → the Edit screen, on an agent with no id yet.
  await page.evaluate(() => window.newCascade());
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(".priobtn.cin").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  await page.locator(".scard").first().click();
  await page.waitForFunction(() => onbStepKey === "briefing");
  await page.waitForTimeout(400);

  expect(await page.evaluate(() => (onbFlow.draft || {}).id)).toBeFalsy();
  await expect(page.locator("#onbStepInner .osdel"),
    "an uncommitted agent offers a Delete that could not delete anything").toHaveCount(0);
  await expect(page.locator("#onbStepInner .oscta")).toBeVisible();
});
