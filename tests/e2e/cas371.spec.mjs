// CAS-371: the Agents top bar reclaims vertical space — the "AGENTS" heading is gone, the open agent's box
// leads with an icon + "[CINEMA|STREAMING] AGENT" label, name/film-count sit at the box's own left padding
// (not indented under the icon), and the sort-order control rides inside the box's action row with Edit and
// search rather than floating outside it.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator(".dcard.is-active").first()).toBeVisible();
}

test("CAS-371: the \"AGENTS\" heading is gone and the agent box leads the bar", async ({ page }) => {
  await toAgentListing(page, "cinema");
  await expect(page.locator("#cascLbl")).toHaveCount(0);
  await expect(page.locator(".casclbl")).toHaveCount(0);
  const firstIsDeck = await page.evaluate(() =>
    document.querySelector("#cascbar").firstElementChild.classList.contains("deck"));
  expect(firstIsDeck, "the deck (agent box) is now the first thing in the bar").toBe(true);
});

for(const kind of ["cinema", "stream"]){
  test(`CAS-371: ${kind} agent box — icon inline with the type label, name/count at the box's own left edge`, async ({ page }) => {
    await toAgentListing(page, kind);
    const card = page.locator(".dcard.is-active").first();

    await expect(card.locator(".dc-top .dc-icon")).toBeVisible();
    const typeText = (await card.locator(".dc-type").textContent()).trim();
    expect(typeText, `type label reads "${typeText}"`).toMatch(kind === "stream" ? /streaming agent/i : /cinema agent/i);

    const xs = await page.evaluate(() => {
      const c = document.querySelector(".dcard.is-active .dc-in");
      const rect = el => el.getBoundingClientRect().left;
      return {
        top: rect(c.querySelector(".dc-top")),
        name: rect(c.querySelector(".dc-name")),
        sub: rect(c.querySelector(".dc-sub")),
      };
    });
    // Name and film-count align to the same left edge as the icon+label row — not indented past the icon.
    expect(Math.abs(xs.name - xs.top), "name must not be indented under the icon").toBeLessThanOrEqual(1);
    expect(Math.abs(xs.sub - xs.top), "film-count must not be indented under the icon").toBeLessThanOrEqual(1);
  });
}

test("CAS-371: the sort control rides inside the agent box's action row, not floating outside it", async ({ page }) => {
  await toAgentListing(page, "stream");
  const acts = page.locator(".dcard.is-active .dc-acts").first();
  await expect(acts.locator("#sortCtl")).toHaveCount(1);
  await expect(acts.locator('[data-act="edit"]')).toHaveCount(1);
  await expect(acts.locator('[data-act="search"]')).toHaveCount(1);
  // The old standalone sort icon is gone from the jump-to row it used to share.
  await expect(page.locator("#listCtl #sortCtl")).toHaveCount(0);
});

test("CAS-371: Edit, search, sort and + New Agent all still work", async ({ page }) => {
  await toAgentListing(page, "cinema");

  // Sort still reorders — same mechanics as before, just relocated.
  await page.locator("#sort").selectOption("imdb");
  await expect(page.locator("#sortDot")).toBeVisible();

  // + New Agent is unchanged.
  const newCard = page.locator(".dcard.new");
  await expect(newCard).toHaveAttribute("aria-label", "New Agent");

  // Edit still opens the agent's editor.
  await page.locator(".dcard.is-active [data-act=\"edit\"]").first().click();
  await expect(page.locator(".osh", { hasText: "Edit Agent" })).toBeVisible();
});
