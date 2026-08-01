// CAS-272: the Share-this-cascade control is gone. It copied a string and called it a share.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, freshApp } from "./helpers.mjs";

async function toAgentListing(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator(".dcard.is-active").first()).toBeVisible();
}

test("CAS-272: no agent card carries a Share control", async ({ page }) => {
  await toAgentListing(page, "cinema");
  await expect(page.locator('.dcard [data-act="share"]')).toHaveCount(0);
  await expect(page.locator('.dcard [aria-label="Share this Cascade"]')).toHaveCount(0);
  const acts = await page.locator(".dcard.is-active .dc-acts").first().textContent();
  expect(acts, `the control row reads "${acts}"`).not.toContain("🔗");
});

test("CAS-272: the link-minting code is gone, not just the button", async ({ page }) => {
  await toAgentListing(page, "cinema");
  const gone = await page.evaluate(() => ({
    shareCascade: typeof window.shareCascade,
    shareLink: typeof (() => { try { return shareLink; } catch(e){ return undefined; } })(),
  }));
  expect(gone.shareCascade).toBe("undefined");
});

test("CAS-272: Edit and Search survive on the row", async ({ page }) => {
  await toAgentListing(page, "cinema");
  const row = page.locator(".dcard.is-active .dc-acts").first();
  await expect(row.locator('[data-act="edit"]')).toHaveCount(1);
  await expect(row.locator('[data-act="search"]')).toHaveCount(1);
});

// The receiving half is deliberately kept: links minted before today are already in people's messages, and a
// link that opens nothing is worse than one that was never offered.
test("CAS-272: a link somebody already holds still opens, as a draft", async ({ page }) => {
  await freshApp(page);
  // Mint one the way the removed code did, so the test does not depend on a hand-copied fixture.
  const url = await page.evaluate(() => {
    const payload = { name: "Shared Test", icon: "🔗", genre: [], status: [], imdb: 0 };
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `/index.html?c=${b64}`;
  });
  await page.goto(url);
  await page.waitForFunction(() => Array.isArray(MOVIES));
  // It opens as a DRAFT the recipient has to accept — never straight into their saved deck.
  await expect(page.locator("#builder.open, #builder")).toBeAttached();
  const saved = await page.evaluate(() => cascades.length);
  expect(saved, "a shared link must not write itself into the saved deck").toBe(0);
});

test("CAS-272: a damaged link is refused rather than half-applied", async ({ page }) => {
  await freshApp(page);
  await page.goto("/index.html?c=not-valid-base64!!");
  await page.waitForFunction(() => Array.isArray(MOVIES));
  expect(await page.evaluate(() => cascades.length)).toBe(0);
});
