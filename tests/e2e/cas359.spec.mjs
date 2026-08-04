// CAS-359 (2026-08-05 correction): user-facing "Purchase" and "Buy" become "Premium" everywhere the pvod
// window is named — a label/copy change only, the underlying `pvod`/`premium` keys are untouched. This
// reverses the ticket's earlier "Buy" direction (see git history for the prior commit). One row is the
// deliberate exception: the per-Cascade editor's spine (buildSpine, #cSpine) prints the window's own title
// next to its alertName on the same line, and both would become the same word ("Premium" pill next to a
// "📣 Premium" bell) — a genuine duplicate-label collision, not a plain rename, so it stays
// "Premium"/"Purchase" pending Lee's call on wording (see the comment above that row in app_template.html).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-359: the card's availability strip names the pvod window Premium, not Buy", async ({ page }) => {
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
  expect(result).toBe("Premium");
});

test("CAS-359: the global 'never alert me' pvod chip reads Premium, not Buy", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator(".navitem", { hasText: "My services" }).click();
  await expect(page.locator("#prefs")).toHaveClass(/open/);
  const chip = page.locator('#prefAlertChips .chip[data-val="pvod"]');
  await expect(chip).toHaveText("💳 Premium");
});

test("CAS-359: every other Purchase/Buy surface renamed to Premium, keys and identifiers untouched", async ({ page }) => {
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
  expect(values.statusLabel).not.toMatch(/^Buy/);
  expect(values.cstageLabel).toBe("Premium");
  expect(values.scopeShort).toBe("premium");
  expect(values.alertShort).toBe("premium");
  expect(values.alertMoment).not.toMatch(/buy/);
  expect(values.alertTypeLabel).toBe("💳 Premium");
  expect(values.streamAgentLabel).toBe("Premium");
  expect(values.windowRungKey).toBe(2);
  expect(values.watchLevelKeys).toBe(true);
  expect(values.pvodStillAKey).toBe(true);
});

test("CAS-359: the flagged AVAIL_ROWS collision is still parked, not silently collapsed", async ({ page }) => {
  await toShortlist(page, "cinema");
  const row = await page.evaluate(() => AVAIL_ROWS.find(r => r.key === "pvod"));
  // Documents the deliberate exception: if this ever starts failing because someone renamed both fields to
  // the same word, that's the duplicate-label collision the ticket comment warns about — it needs Lee's
  // decision on wording, not a reflexive fix.
  expect(row.title).toBe("Premium");
  expect(row.alertName).toBe("Purchase");
});
