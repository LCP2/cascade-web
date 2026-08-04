// CAS-243: the streaming agent's pay-per-film windows are two, and Buy (CAS-359, formerly Premium) is not
// one you are opted into.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-243: Streaming settings offer Buy, Standard Rent and Streaming, each with both switches", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => window.editCascade());
  await page.locator(".osdoor", { hasText: "Notifications" }).click();   // CAS-267 renamed this row
  await expect(page.locator(".osh", { hasText: /Where & when/ })).toBeVisible();

  const lanes = await page.locator("#wwLanes .wwlane").evaluateAll(ls => ls.map(l => ({
    name: (l.querySelector(".wwn")?.textContent || "").trim(),
    on: l.classList.contains("on"),
    switches: [...l.querySelectorAll(".agwt")].map(b => b.textContent.trim()),
  })));
  expect(lanes.map(l => l.name)).toEqual(["Buy", "Standard Rent", "Streaming"]);
  for(const l of lanes) expect(l.switches.length, `${l.name} must carry List and Notify`).toBe(2);

  // The onboarding assumption: Buy off, the other two on.
  expect(lanes.find(l => l.name === "Buy").on, "a new agent must not be opted into ~$30 buy/rent").toBe(false);
  expect(lanes.find(l => l.name === "Standard Rent").on).toBe(true);
  expect(lanes.find(l => l.name === "Streaming").on).toBe(true);
  // A streaming agent is never offered a cinema window.
  await expect(page.locator("#wwLanes")).not.toContainText(/Upcoming|In cinema/);

  // Switching Buy on really widens the agent, and arms the bell that goes with it.
  const before = await page.evaluate(() => { const d = onbApply(); return { s: d.status, a: d.alerts }; });
  expect(before.s).not.toContain("pvod");
  expect(before.a.pvod).toBe(false);
  await page.locator("#wwLanes .wwlane", { hasText: "Buy" }).locator(".agwt", { hasText: "Notify" }).click();
  const after = await page.evaluate(() => { const d = onbApply(); return { s: d.status, l: d.listStatus, a: d.alerts }; });
  expect(after.s, "a notified window must be watched").toContain("pvod");
  expect(after.l, "…but Notify alone must not list it").not.toContain("pvod");
  expect(after.a.pvod).toBe(true);
});
