// CAS-551: top menu reorder — Agent Preferences (renamed from Preferences) moves directly under Manage
// Agents, grouping the two agent surfaces together; Account drops to second-last, next to About. Route
// keys (navMenuGo('preferences')/navMenuGo('account')) and the screens they open are unchanged — this is
// a label + DOM-order change only.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-551: the top menu renders Notifications, Manage Agents, Agent Preferences, My services, Service analysis, Lists, Account, About in that order", async ({ page }) => {
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
    "Agent Preferences",
    "My services",
    "Service analysis",
    "Lists",
    "Account",
    "About",
  ]);
});

test("CAS-551: Agent Preferences opens the same Preferences screen as before", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Agent Preferences" }).click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#preferencesScreen")).toHaveClass(/open/);
  // AC4: the screen's own heading is left as "Preferences" — the row label changed, not the screen.
  await expect(page.locator("#preferencesScreen .osh")).toHaveText("Preferences");
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
  await expect(items).toHaveCount(8);
  const roles = await items.evaluateAll(els => els.map(el => el.getAttribute("role")));
  expect(roles.every(r => r === "menuitem")).toBe(true);

  // DOM order (no CSS `order` override on .navmenu/.navitem) is what Tab walks, so asserting DOM order
  // is equivalent to asserting keyboard-navigation order here.
  const domOrder = await items.evaluateAll(els => els.map(el => el.textContent.replace(/\s+/g, " ").trim()));
  expect(domOrder[1]).toBe("Manage Agents");
  expect(domOrder[2]).toBe("Agent Preferences");
  expect(domOrder[domOrder.length - 2]).toBe("Account");
  expect(domOrder[domOrder.length - 1]).toBe("About");
});
