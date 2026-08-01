// CAS-240: exact AU dates under the lozenges where we hold one.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-240: a known date is shown to the day, an estimate is not", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const strips = await page.locator("#groups .card .bandw").count();
  expect(strips, "no availability strips on the listing").toBeGreaterThan(0);

  const seen = await page.evaluate(() => {
    const out = { exact: 0, est: 0, badExact: [], badEst: [] };
    document.querySelectorAll("#groups .card .wdate").forEach(el => {
      const text = (el.textContent || "").trim();
      if(text === "—") return;
      if(el.classList.contains("exact")){
        out.exact++;
        // A day, a month, and optionally a two-digit year: "26 Jul" or "21 Nov 19".
        if(!/^\d{1,2} [A-Z][a-z]{2}( \d{2})?$/.test(text)) out.badExact.push(text);
        if(!el.title) out.badExact.push("no tooltip: " + text);
      } else if(el.classList.contains("est")){
        out.est++;
        // An estimate stays a month and a year — a day would claim a precision the offset does not have.
        // CAS-310: and it leads with "≈", the app's own estimate glyph, so the meaning survives on touch.
        if(!/^≈ [A-Z][a-z]{2} \d{2}$/.test(text)) out.badEst.push(text);
      }
    });
    return out;
  });
  expect(seen.badExact, "an exact date is not in the day form, or has no tooltip").toEqual([]);
  expect(seen.badEst, "an estimated date is being shown to the day").toEqual([]);
  expect(seen.exact, "no exact dates on the whole listing").toBeGreaterThan(0);
});

test("CAS-240: the tooltip says which KIND of date it is", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const titles = await page.locator("#groups .card .wdate.exact").evaluateAll(els =>
    els.map(e => ({ cell: e.closest(".win").className, title: e.title })));
  expect(titles.length).toBeGreaterThan(0);
  for(const t of titles){
    if(/w-cin-/.test(t.cell)) expect(t.title, "a cinema date must be named as the AU release").toMatch(/AU release date/);
    else expect(t.title, "a home date must be named as a sighting, not a release").toMatch(/first saw it here/);
  }
});
