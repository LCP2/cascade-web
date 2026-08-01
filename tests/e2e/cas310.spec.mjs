// CAS-310: an estimated offer date used to be told apart from a real one by italic font-style alone, plus a
// title= tooltip that (per the IMDb gate's own comment elsewhere) a phone can never reach. So on touch the
// two kinds of date looked identical. The fix leads every estimate with "≈", the app's own always-visible
// estimate glyph (used already on the estline and the Found list), so the meaning survives without a hover.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-310: every estimated date leads with the ≈ glyph, no exact date does", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const seen = await page.evaluate(() => {
    const out = { est: 0, exact: 0, badEst: [], badExact: [] };
    document.querySelectorAll("#groups .card .wdate").forEach(el => {
      const text = (el.textContent || "").trim();
      if(text === "—") return;
      if(el.classList.contains("est")){
        out.est++;
        if(!text.startsWith("≈ ")) out.badEst.push(text);
      } else if(el.classList.contains("exact")){
        out.exact++;
        if(text.startsWith("≈")) out.badExact.push(text);
      }
    });
    return out;
  });
  expect(seen.est + seen.exact, "no dated windows on the listing to check").toBeGreaterThan(0);
  expect(seen.badEst, "an estimated date is missing its ≈ marker").toEqual([]);
  expect(seen.badExact, "an exact date wrongly carries the ≈ marker").toEqual([]);
});
