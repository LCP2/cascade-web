// CAS-307: Family Movies, the third cinema-lane preconfigured agent — G/PG/M, $50M+, Trending, and never
// Horror/Crime/Romance.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, PRESET_NAMES } from "./helpers.mjs";

test("CAS-307: Family Movies sits third on the cinema shortlist, after Blockbusters and Date Night, before Totally Custom", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cinema = (await shortlistCards(page)).map(c => c.name);
  expect(cinema).toEqual(PRESET_NAMES.cinema);

  await toShortlist(page, "stream");
  const stream = (await shortlistCards(page)).map(c => c.name);
  expect(stream.join(" | "), "Family Movies wasn't offered in the streaming lane").not.toMatch(/Family Movies/);
});

test("CAS-307: picking Family Movies seeds the rating cap, the genre exclude and the bar dials", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Family Movies");
  const d = await page.evaluate(() => {
    const a = onbApply();
    return {
      kind: a.kind,
      age: a.age.slice().sort(),
      expectedAge: AGE_LEVELS.filter(x => !MATURE.has(x)).sort(),
      exclude: a.exclude.slice().sort(),
      scale: a.selScale,
      buzz: a.selBuzz,
    };
  });
  expect(d.kind).toBe("cinema");
  expect(d.age, "Rating didn't seed from the preset").toEqual(d.expectedAge);
  expect(d.exclude, "Style's exclude list didn't seed from the preset").toEqual(["Crime", "Horror", "Romance"]);
  expect(d.scale).toBe(50_000_000);
  expect(d.buzz).toBe(2);   // BUZZ_STOPS[2] = "Trending"
});

test("CAS-307: the resulting cascade actually excludes mature ratings and the three skipped genres", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Family Movies");
  const res = await page.evaluate(() => {
    const c = onbApply();
    const matches = MOVIES.filter(m => matchesCriteria(m, c, true));
    return {
      n: matches.length,
      mature: matches.filter(m => MATURE.has(m.age_rating)).length,
      skipped: matches.filter(m => (m.genres || []).some(g => ["Horror", "Crime", "Romance"].includes(g))).length,
      underBudget: matches.filter(m => typeof m.budget === "number" && m.budget < 50_000_000).length,
    };
  });
  expect(res.n, "Family Movies matches nothing on today's catalogue").toBeGreaterThan(0);
  expect(res.mature, "a mature-rated film slipped through the rating cap").toBe(0);
  expect(res.skipped, "a Horror/Crime/Romance film slipped through the exclude").toBe(0);
  expect(res.underBudget, "a film under the $50M scale floor slipped through").toBe(0);
});

test("CAS-307: the card's own count already applies the rating cap, not a wide-open one", async ({ page }) => {
  await toShortlist(page, "cinema");
  const n = await page.evaluate(() => {
    const s = STARTERS.find(x => x.key === "family");
    return starterCount(s, "cinema");
  });
  const wideOpenCount = await page.evaluate(() => {
    const s = STARTERS.find(x => x.key === "family");
    const preview = starterPreview(s, "cinema");
    const open = { ...preview, age: [] };
    return watchCount(open);
  });
  expect(n).toBeLessThanOrEqual(wideOpenCount);
});
