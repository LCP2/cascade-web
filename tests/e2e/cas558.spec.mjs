// CAS-558: on iOS, .modal is position:fixed sized to the LAYOUT viewport, which does not shrink for the
// software keyboard — only the visual viewport does. A .cascfoot sticky to that fixed container's bottom
// therefore sticks below what's actually visible, and Safari's scroll-into-view for the focused field
// lands the field right behind it. The fix un-sticks .cascfoot (via a .kbfocus class on its sheet) for as
// long as a text field inside that sheet holds focus.
//
// No soft keyboard and no visual-viewport shrink exist in headless Chromium, so this suite drives the
// MECHANISM the fix relies on — the focusin/focusout delegate toggling .kbfocus, and .cascfoot's
// position/z-index rules — not the on-device symptom itself. The reported screen (#authModal's
// #authSignedOut/#authEmail) needs real Supabase config to reach in this network-free suite (see
// helpers.mjs), so this drives the identical mechanism on two other .cascfoot screens that ARE reachable
// guest-mode: the Cascade Builder editor (#cName) and Save As (#saveAsName). Same delegate, same CSS rule,
// same class — proving it here proves it for #authEmail too. Manual device check remains the real
// verification of the on-device symptom, per the ticket's own note.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const cascfootPosition = (page, sheetSel) =>
  page.locator(`${sheetSel} .cascfoot`).first().evaluate(el => getComputedStyle(el).position);

test("CAS-558: focusing a text field next to .cascfoot un-sticks it, blurring re-sticks it (builder)", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => { draft = {}; openEditor("Test"); openModal($("builder")); });
  await expect(page.locator("#cName")).toBeVisible();

  await expect(page.locator("#builder")).not.toHaveClass(/kbfocus/);
  expect(await cascfootPosition(page, "#builder")).toBe("sticky");

  await page.locator("#cName").focus();
  await expect(page.locator("#builder")).toHaveClass(/kbfocus/);
  expect(await cascfootPosition(page, "#builder")).toBe("static");

  await page.locator("#cName").blur();
  await expect(page.locator("#builder")).not.toHaveClass(/kbfocus/);
  expect(await cascfootPosition(page, "#builder")).toBe("sticky");
});

test("CAS-558: the same un-stick applies to every other sheet pairing a text field with .cascfoot (Save As)", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => openModal($("saveAs")));
  await expect(page.locator("#saveAsName")).toBeVisible();

  await page.locator("#saveAsName").focus();
  await expect(page.locator("#saveAs")).toHaveClass(/kbfocus/);
  expect(await cascfootPosition(page, "#saveAs")).toBe("static");

  await page.locator("#saveAsName").blur();
  await expect(page.locator("#saveAs")).not.toHaveClass(/kbfocus/);
  expect(await cascfootPosition(page, "#saveAs")).toBe("sticky");
});

test("CAS-558: sheets with no text field next to .cascfoot never get .kbfocus (Log)", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => openModal($("logModal")));
  await expect(page.locator("#logClear")).toBeVisible();

  await page.locator("#logClear").focus();
  await expect(page.locator("#logModal")).not.toHaveClass(/kbfocus/);
  expect(await cascfootPosition(page, "#logModal")).toBe("sticky");
});

test("CAS-558: .cascfoot's stacking is set explicitly, not left to DOM order", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => openModal($("saveAs")));

  const zIndex = await page.locator("#saveAs .cascfoot").evaluate(el => getComputedStyle(el).zIndex);
  expect(zIndex).not.toBe("auto");
});

test("CAS-558: the account sheet's #authMsg sits between the input and .cascfoot, not below it", async ({ page }) => {
  await freshApp(page);

  const order = await page.evaluate(() => {
    const kids = [...document.getElementById("authSignedOut").children].map(el => el.id || el.className);
    return { emailIdx: kids.indexOf("authEmail"), msgIdx: kids.indexOf("authMsg"),
             footIdx: kids.findIndex(k => k.split(" ").includes("cascfoot")) };
  });

  expect(order.emailIdx).toBeGreaterThanOrEqual(0);
  expect(order.msgIdx).toBeGreaterThan(order.emailIdx);
  expect(order.footIdx).toBeGreaterThan(order.msgIdx);
});
