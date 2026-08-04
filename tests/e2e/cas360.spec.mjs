// CAS-360: TMDB release_dates types are stored on every film (CAS-360 python-side tests cover the ingest
// mapping), cinema_release is derived from an AU type-3 record, and that drives two surfaces here — the
// card's "Cinema Release" tag and the streaming agent's Mission checkbox. Both are type-3 ONLY: a type-2
// (limited) or any other type must never light either one.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, freshApp } from "./helpers.mjs";

test("CAS-360: the Cinema Release chip is type-3 only, regardless of what else is stored", async ({ page }) => {
  await freshApp(page);
  const result = await page.evaluate(() => ({
    withRelease:  cinemaReleaseChip({ cinema_release: true }).includes("Cinema Release"),
    withoutFlag:  cinemaReleaseChip({ cinema_release: false }) === "",
    // A film that only ever had a limited (type 2) release must not be tagged just because release_dates
    // is populated — cinema_release, not the presence of any record, is what the chip reads.
    limitedOnly:  cinemaReleaseChip({ cinema_release: false,
                                       release_dates: [{ region: "AU", type: 2, date: "2026-01-01" }] }) === "",
  }));
  expect(result.withRelease).toBe(true);
  expect(result.withoutFlag).toBe(true);
  expect(result.limitedOnly).toBe(true);
});

test("CAS-360: the streaming Mission has a working Cinema Release checkbox, default off", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);

  const toggle = page.locator("#onbCinemaRelease");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toHaveClass(/on/);
  expect(await page.evaluate(() => onbApply().cinemaReleaseOnly)).toBe(false);

  const before = await page.evaluate(() => onbCount());
  await toggle.click();
  await expect(toggle).toHaveClass(/on/);
  const after = await page.evaluate(() => ({ v: onbApply().cinemaReleaseOnly, n: onbCount() }));
  expect(after.v).toBe(true);
  expect(after.n).toBeLessThanOrEqual(before);

  // Whatever it now matches, every one of those films really does carry a type-3 AU release — trivially
  // true on today's catalogue if nothing has been re-ingested since CAS-360 shipped, and a real check once
  // it has (see the python-side _tmdb_record tests for the ingest half of this).
  const allCinemaRelease = await page.evaluate(() =>
    MOVIES.filter(m => matchesCriteria(m, onbApply())).every(m => m.cinema_release === true));
  expect(allCinemaRelease).toBe(true);
});

test("CAS-360: the cinema Mission has no Cinema Release checkbox — release history isn't a cinema-lane question", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await expect(page.locator("#onbCinemaRelease")).toHaveCount(0);
  expect(await page.evaluate(() => onbApply().cinemaReleaseOnly)).toBe(false);
});

test("CAS-360: the checkbox survives a save and reopening the streaming agent's Mission", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.locator("#onbCinemaRelease").click();
  await finishFlow(page);
  await toListing(page);

  await page.evaluate(() => window.editCascade());
  await page.locator("#onbStepInner .osdoor", { hasText: "Mission" }).click();
  await expect(page.locator("#onbCinemaRelease")).toHaveClass(/on/);
  expect(await page.evaluate(() => activeCascade().cinemaReleaseOnly)).toBe(true);
});

test("CAS-360: a cinema agent never carries the streaming-only checkbox as a hidden filter", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  expect(await page.evaluate(() => activeCascade().cinemaReleaseOnly)).toBe(false);
});
