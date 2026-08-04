// CAS-359: user-facing "Premium" and "Purchase" become "Buy" everywhere the pvod window is named — a
// label/copy change only, the underlying `pvod`/`premium` keys are untouched. One row is the deliberate
// exception: the per-Cascade editor's spine (buildSpine, #cSpine) prints the window's own title next to its
// alertName on the same line, and both were about to become the same word ("Buy" pill next to a "📣 Buy"
// bell) — a genuine duplicate-label collision, not a plain rename, so it stays "Premium"/"Purchase" pending
// Lee's call on wording (see the comment above that row in app_template.html).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-359: the card's availability strip names the pvod window Buy, not Premium", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const result = await page.evaluate(() => {
    const card = [...document.querySelectorAll("#groups .card")].find(c => {
      const id = Number(c.id.replace("card-", ""));
      const m = MOVIES.find(x => x.tmdb_id === id);
      return m && primaryStatus(m) === "pvod";
    });
    if(!card) return null;
    return (card.querySelector(".avail .win.on .wpill")?.textContent || "").trim();
  });
  test.skip(result === null, "no film is in the pvod window today");
  expect(result).toBe("Buy");
});

test("CAS-359: the global 'never alert me' pvod chip reads Buy, not Purchase", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator(".navitem", { hasText: "My services" }).click();
  await expect(page.locator("#prefs")).toHaveClass(/open/);
  const chip = page.locator('#prefAlertChips .chip[data-val="pvod"]');
  await expect(chip).toHaveText("💳 Buy");
});

test("CAS-359: every other Premium/Purchase surface renamed to Buy, keys and identifiers untouched", async ({ page }) => {
  await toShortlist(page, "cinema");
  const values = await page.evaluate(() => ({
    statusLabel: STATUS_LABEL.pvod,
    cstageLabel: CSTAGE_LABEL.pvod,
    scopeShort: SCOPE_SHORT.pvod,
    alertShort: ALERT_SHORT.pvod,
    alertMoment: ALERT_MOMENT.pvod,
    alertTypeLabel: ALERT_TYPES.find(t => t.key === "pvod").label,
    streamAgentLabel: AGENT_WINDOWS.stream.find(w => w.key === "premium").label,
    // Keys and identifiers must not move — this is copy-only.
    windowRungKey: WINDOW_RUNG.premium,
    watchLevelKeys: WATCH_LEVEL_KEYS.includes("premium"),
    pvodStillAKey: ALL_WINDOWS.includes("pvod"),
  }));
  expect(values.statusLabel).not.toMatch(/Premium/);
  expect(values.cstageLabel).toBe("Buy");
  expect(values.scopeShort).toBe("buy");
  expect(values.alertShort).toBe("buy");
  expect(values.alertMoment).not.toMatch(/premium/);
  expect(values.alertTypeLabel).toBe("💳 Buy");
  expect(values.streamAgentLabel).toBe("Buy");
  expect(values.windowRungKey).toBe(2);
  expect(values.watchLevelKeys).toBe(true);
  expect(values.pvodStillAKey).toBe(true);
});

test("CAS-359: the flagged AVAIL_ROWS collision is still parked, not silently collapsed", async ({ page }) => {
  await toShortlist(page, "cinema");
  const row = await page.evaluate(() => AVAIL_ROWS.find(r => r.key === "pvod"));
  // Documents the deliberate exception: if this ever starts failing because someone renamed both fields to
  // "Buy", that's the duplicate-label collision the ticket comment warns about — it needs Lee's decision on
  // wording, not a reflexive fix.
  expect(row.title).toBe("Premium");
  expect(row.alertName).toBe("Purchase");
});
