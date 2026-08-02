// CAS-288: with a Budget band chosen, films with no budget figure are not listed.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing, sectionCounts } from "./helpers.mjs";

test("CAS-288: every band excludes the unbudgeted, and the opt-in cannot bring them back", async ({ page }) => {
  await freshApp(page);
  const out = await page.evaluate(() => {
    const rows = [];
    for(let band = 1; band < BUDGET_BANDS.length; band++){
      // Both ways round: the flag used to be the escape hatch, so assert it changes nothing now.
      for(const flag of [false, true]){
        const c = normCascade({ id: "t", name: "t", kind: "stream", budget: band, includeUnbudgeted: flag });
        const hit = MOVIES.filter(m => matchesCriteria(m, c));
        rows.push({ band, flag, total: hit.length, unbudgeted: hit.filter(m => !m.budget).length });
      }
    }
    return rows;
  });
  for(const r of out){
    expect(r.unbudgeted, `band ${r.band} (includeUnbudgeted=${r.flag}) listed ${r.unbudgeted} films with no budget`).toBe(0);
  }
  // The old flag is inert: the same band gives the same answer either way.
  for(let i = 0; i < out.length; i += 2){
    expect(out[i].total, `band ${out[i].band} still responds to the removed opt-in`).toBe(out[i + 1].total);
  }
});

test("CAS-288: at Any budget nothing is excluded", async ({ page }) => {
  await freshApp(page);
  const same = await page.evaluate(() => {
    const c = normCascade({ id: "t", name: "t", kind: "stream", budget: 0 });
    const withBudgetFilter = MOVIES.filter(m => budgetOK(m, 0)).length;
    return { all: MOVIES.length, withBudgetFilter, matched: MOVIES.filter(m => matchesCriteria(m, c)).length };
  });
  expect(same.withBudgetFilter, "band 0 asks nothing, so it must exclude nothing").toBe(same.all);
});

test("CAS-288: the opt-in control is gone from the editor", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#cUnbudgeted")).toHaveCount(0);
  const src = await page.evaluate(() => document.documentElement.outerHTML);
  expect(src, "a control that can no longer change anything must not remain").not.toContain("cUnbudgeted");
});

test("CAS-288: budgetOK no longer takes the flag at all", async ({ page }) => {
  await freshApp(page);
  // Two arguments, not three — the parameter that carried the exception is gone rather than ignored.
  expect(await page.evaluate(() => budgetOK.length)).toBe(2);
});

test("CAS-288: the band count and the band's own filter agree", async ({ page }) => {
  await freshApp(page);
  const rows = await page.evaluate(() => {
    const out = [];
    for(let band = 1; band < BUDGET_BANDS.length; band++){
      out.push({ band, counted: budgetBandCount(band), filtered: MOVIES.filter(m => budgetOK(m, band)).length });
    }
    return out;
  });
  for(const r of rows) expect(r.counted, `band ${r.band}`).toBe(r.filtered);
});

// The ticket asks for this to be checked through the count-consistency layer, not just the predicate.
test("CAS-288: a real agent with a budget band lists only films with a known budget", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => {
    const c = activeCascade();
    c.budget = 2;
    saveCascades(); applyCascade(c); render();
  });
  await page.waitForTimeout(600);
  const bad = await page.evaluate(() => {
    const c = activeCascade();
    return MOVIES.filter(m => listedBy(m, c) && !m.budget).map(m => m.title).slice(0, 5);
  });
  expect(bad, `listed with no budget: ${JSON.stringify(bad)}`).toEqual([]);

  // …and the listing on screen matches that, section counts included.
  const sections = await sectionCounts(page);
  const listed = sections.reduce((a, s) => a + s.count, 0);
  const expected = await page.evaluate(() => {
    const c = activeCascade();
    return MOVIES.filter(m => listedBy(m, c) && !taggedOut(m)).length;
  });
  expect(listed).toBe(expected);
});
