// CAS-475: Language and Streaming services are account-level only now — the per-agent Edit Agent hub no
// longer carries a Language row for either lane, or a Streaming services row for a Streaming agent. Both
// remain configurable at Account > Taste baseline and Account > My streaming services, which is the only
// place either lives now.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toListingWithAgent(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

async function openEditAgent(page){
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  return page.locator(".osdoor .dh");
}

test("CAS-475: a Cinema agent's Edit Agent hub has no Language row", async ({ page }) => {
  await toListingWithAgent(page, "cinema");
  const rowLabels = await openEditAgent(page);
  await expect(rowLabels).toHaveText(["Agent Name", "Mission", "Style", "Rating", "Where & when you'll watch"]);
});

test("CAS-475: a Streaming agent's Edit Agent hub has no Language row and no Streaming services row", async ({ page }) => {
  await toListingWithAgent(page, "stream");
  const rowLabels = await openEditAgent(page);
  await expect(rowLabels).toHaveText(["Agent Name", "Mission", "Style", "Rating", "How far back", "Where & when you'll watch"]);
});

test("CAS-475: Account settings is still the one place Language and My streaming services are configured", async ({ page }) => {
  await toListingWithAgent(page, "stream");
  await page.evaluate(() => window.openAccount());
  await expect(page.locator(".osh", { hasText: "Account" })).toBeVisible();

  const rows = page.locator(".ucard .urow");
  await expect(rows.filter({ has: page.locator(".ut", { hasText: "Taste baseline" }) })).toHaveCount(1);
  await expect(rows.filter({ has: page.locator(".ut", { hasText: "My streaming services" }) })).toHaveCount(1);

  // Taste baseline's own live summary line is where Language now reads from — it names a language, not "None".
  const tasteSub = rows.filter({ has: page.locator(".ut", { hasText: "Taste baseline" }) }).locator(".ussub");
  await expect(tasteSub).not.toHaveText("");

  // Opening it lands on the same accordion that carries the Language row — proving the setting still exists
  // and lives here, not just that the summary text mentions a language.
  await rows.filter({ has: page.locator(".ut", { hasText: "Taste baseline" }) }).click();
  await expect(page.locator('.tbrow[data-row="langs"] .rlabel', { hasText: "Language" })).toBeVisible();
});
