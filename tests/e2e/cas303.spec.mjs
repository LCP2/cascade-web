// CAS-303: refines CAS-268's Delete on the Edit Agent page — it was a full-width bordered block the same
// size as Save, which read as too prominent for a destructive action. It must now be a quiet, text-style
// control tucked under Save, while still being a real tap target and still confirming before it deletes.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function buildAgent(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

const openEdit = async page => {
  await page.evaluate(() => window.editCascade());
  await expect(page.locator("#onbStepInner .osdoor").first()).toBeVisible();
};

test("CAS-303: Delete reads as a quiet text control, not a bordered block", async ({ page }) => {
  await buildAgent(page);
  await openEdit(page);

  const del = page.locator("#onbStepInner .osdel");
  await expect(del).toBeVisible();
  await expect(del).toHaveText("Delete agent");

  const [delStyle, saveStyle] = await Promise.all([
    del.evaluate(el => {
      const cs = getComputedStyle(el);
      return { borderStyle: cs.borderStyle, background: cs.backgroundColor, fontSize: parseFloat(cs.fontSize),
        fontWeight: Number(cs.fontWeight), textDecoration: cs.textDecorationLine };
    }),
    page.locator("#onbStepInner .oscta").evaluate(el => {
      const cs = getComputedStyle(el);
      return { fontSize: parseFloat(cs.fontSize), fontWeight: Number(cs.fontWeight) };
    }),
  ]);

  expect(delStyle.borderStyle, "still has a border box").toBe("none");
  expect(delStyle.background, "still has a fill").toBe("rgba(0, 0, 0, 0)");
  expect(delStyle.textDecoration, "does not read as plain text").toContain("underline");
  expect(delStyle.fontSize, "as loud as Save").toBeLessThan(saveStyle.fontSize);
  expect(delStyle.fontWeight, "bolder than Save").toBeLessThanOrEqual(saveStyle.fontWeight);

  // Still discoverable: a real tap target under the small label, sitting below Save.
  const [save, box] = await Promise.all([
    page.locator("#onbStepInner .oscta").boundingBox(),
    del.boundingBox(),
  ]);
  expect(box.y, "Delete sits above Save").toBeGreaterThan(save.y);
  expect(box.height, "Delete shrank into an unreliable tap target").toBeGreaterThanOrEqual(40);
});

test("CAS-303: Delete still confirms before it deletes", async ({ page }) => {
  await buildAgent(page);
  const before = await page.evaluate(() => cascades.length);
  await openEdit(page);

  page.on("dialog", d => d.dismiss());
  await page.locator("#onbStepInner .osdel").click();
  await page.waitForTimeout(300);

  expect(await page.evaluate(() => cascades.length), "Cancel deleted the agent anyway").toBe(before);
  await expect(page.locator("#onbStepInner .osdel"), "the screen closed on Cancel").toBeVisible();
});
