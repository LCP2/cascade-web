// CAS-551: top menu reorder — Agent Preferences (renamed from Preferences) moves directly under Manage
// Agents, grouping the two agent surfaces together; Account drops to second-last, next to About.
//
// CAS-562 landed after this ticket and split the single "Agent Preferences" row into two rows, Languages
// and Where & when you'll watch, in the same slot — so the menu-order and Tab-order assertions below now
// name those two rows instead of the one they replaced. See the CAS-562 fix comment for how the tickets
// reconcile; the DOM-order/reachability behaviour this spec covers is otherwise unchanged.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-551/CAS-562: the top menu renders Notifications, Manage Agents, Languages, Where & when you'll watch, My services, Service analysis, Lists, Account, About in that order", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  const labels = await page.locator("#navMenu .navitem").allTextContents();
  const cleaned = labels.map(t => t.replace(/\s+/g, " ").trim());
  expect(cleaned).toEqual([
    "🔔 Notifications0",
    "Manage Agents",
    "Languages",
    "Where & when you'll watch",
    "My services",
    "Service analysis",
    "Lists",
    "Account",
    "About",
  ]);
});

test("CAS-551/CAS-562: Languages and Where & when you'll watch each open their own screen", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Languages" }).click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#languagesScreen")).toHaveClass(/open/);
  await expect(page.locator("#languagesScreen .osh")).toHaveText("Languages");
  await page.locator("#languagesScreen .osback").click();

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#wwScreen")).toHaveClass(/open/);
  await expect(page.locator("#wwScreen .osh")).toHaveText("Where & when you'll watch");
});

test("CAS-551: Account row now sits second-last and still opens the same Account screen", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  const labels = await page.locator("#navMenu .navitem").allTextContents();
  const accountIdx = labels.findIndex(t => t.trim() === "Account");
  expect(accountIdx).toBe(labels.length - 2);

  await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#accountScreen")).toHaveClass(/open/);
});

test("CAS-551: menu rows keep role=menuitem and Tab walks them in the same visual order", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  const items = page.locator("#navMenu .navitem");
  await expect(items).toHaveCount(9);
  const roles = await items.evaluateAll(els => els.map(el => el.getAttribute("role")));
  expect(roles.every(r => r === "menuitem")).toBe(true);

  // DOM order (no CSS `order` override on .navmenu/.navitem) is what Tab walks, so asserting DOM order
  // is equivalent to asserting keyboard-navigation order here.
  const domOrder = await items.evaluateAll(els => els.map(el => el.textContent.replace(/\s+/g, " ").trim()));
  expect(domOrder[1]).toBe("Manage Agents");
  expect(domOrder[2]).toBe("Languages");
  expect(domOrder[3]).toBe("Where & when you'll watch");
  expect(domOrder[domOrder.length - 2]).toBe("Account");
  expect(domOrder[domOrder.length - 1]).toBe("About");
});
