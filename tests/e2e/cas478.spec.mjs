// CAS-478: the per-agent Filter popup (funnel icon -> Premium / Standard Rent / Streaming) had no heading,
// so it wasn't obvious what the three checkboxes filtered by — a "Watch it" label now sits above the rows.
// A fourth row, "Undecided", filters for films eligible for at least one Watch-it level (CAS-477's shared
// "eligible" = !spent && agentOn) where none of the eligible levels are ticked yet; see filmIsUndecided
// and the filterPanelRowsHTML/scopeRows comments in app_template.html.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing, ctaLocator } from "./helpers.mjs";

async function openNotificationsScreen(page){
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osdoor", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator("#wwLanes .wwlane").first()).toBeVisible();
}

async function setLaneSwitch(page, label, which, desiredOn){
  const lane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: label }) });
  const btn = lane.locator(".agwt", { hasText: which === "notify" ? "Follow" : "List" });
  const isOn = (await btn.getAttribute("aria-pressed")) === "true";
  if(isOn !== desiredOn) await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", String(desiredOn));
}

async function saveAgentAndReturnToListing(page){
  await ctaLocator(page).click();                                    // Done, back to the Edit Agent hub
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osfoot .oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await settleListing(page);
}

test("CAS-478: the Filter panel has a Watch it heading and an Undecided row", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  // A freshly onboarded agent starts Notify off for every window (CAS-427), so nothing is "eligible" yet —
  // Undecided's own gate (filmNotifyState's !spent && agentOn set) would always read empty. Arm Streaming so
  // there is something eligible-but-untouched for the filter to find, without ticking any film's own row.
  await openNotificationsScreen(page);
  await setLaneSwitch(page, "Streaming", "notify", true);
  await saveAgentAndReturnToListing(page);

  const filterBtn = page.locator(".dcard:not(.all) .dc-filter");
  await filterBtn.click();
  const pop = page.locator(".cpop.fpop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".npthd")).toHaveText("Notify");    // CAS-610: relabelled back from "Watch it"

  const tierRows = pop.locator(".nopt[data-tier]");
  await expect(tierRows).toHaveCount(4);

  const undecided = pop.locator('.nopt[data-tier="undecided"]');
  await expect(undecided).toBeVisible();
  await expect(undecided.locator(".nol")).toHaveText("Undecided");
  await expect(undecided).toHaveAttribute("aria-pressed", "false");

  await undecided.click();
  await expect(undecided).toHaveAttribute("aria-pressed", "true");
  await settleListing(page);

  const ids = await page.locator("#groups .card").evaluateAll(els => els.map(el => el.id.replace(/^card-/, "")));
  test.skip(ids.length === 0, "no Undecided film in this agent's listing this run");
  const allUndecided = await page.evaluate(ids => ids.every(id => filmIsUndecided(Number(id))), ids);
  expect(allUndecided).toBe(true);

  // Toggling it back off drops the filter and returns to the full listing.
  await undecided.click();
  await expect(undecided).toHaveAttribute("aria-pressed", "false");
});
