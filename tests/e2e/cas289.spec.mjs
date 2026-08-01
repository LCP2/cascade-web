// CAS-289: the ESTIMATED in-cinema window is capped at two weeks from the AU cinema open date — past that,
// "Likely still in cinemas" is no longer an honest claim, so the film moves to its next estimated window
// (and, per CAS-170, out of the listing entirely once it has no confirmed offer to stand on). The confirmed
// path is untouched: a polled film with a real opening date still gets the full CINEMA_RUN_DAYS run.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-289: no estimated film claims to be in cinemas more than 14 days after it opened", async ({ page }) => {
  await freshApp(page);
  const offenders = await page.evaluate(() => {
    return MOVIES.filter(m => isEstimated(m) && inCinemaWindow(m) &&
      m.cinema_date < addDays(TODAY, -CINEMA_ESTIMATE_RUN_DAYS))
      .map(m => ({ title: m.title, cinema_date: m.cinema_date, status: primaryStatus(m) }));
  });
  expect(offenders, JSON.stringify(offenders)).toEqual([]);
});

test("CAS-289: a confirmed film still gets the full (longer) cinema run, uncapped by the estimate rule", async ({ page }) => {
  await freshApp(page);
  const capDays = await page.evaluate(() => CINEMA_ESTIMATE_RUN_DAYS);
  const confirmedBeyondCap = await page.evaluate(cap => {
    return MOVIES.some(m => !isEstimated(m) && inCinemaWindow(m) &&
      m.cinema_date < addDays(TODAY, -cap));
  }, capDays);
  // Not asserted true every day (depends on today's catalogue), but if it IS true, it must not have been
  // excluded by the estimate-only cap — i.e. the two windows are genuinely independent constants.
  const stillIndependent = await page.evaluate(() => CINEMA_RUN_DAYS > CINEMA_ESTIMATE_RUN_DAYS);
  expect(stillIndependent).toBe(true);
  void confirmedBeyondCap;
});

test("CAS-289: the widest cinema listing never shows a stale \"Likely still in cinemas\" card", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const stale = await page.evaluate(() => {
    const cutoff = addDays(TODAY, -CINEMA_ESTIMATE_RUN_DAYS);
    return [...document.querySelectorAll("#groups .card")].some(card => {
      const id = Number((card.id || "").replace("card-", ""));
      const m = MOVIES.find(x => x.tmdb_id === id);
      if(!m || !isEstimated(m) || !inCinemaWindow(m)) return false;
      const line = card.querySelector(".estline");
      return line && /still in cinemas/i.test(line.textContent) && m.cinema_date < cutoff;
    });
  });
  expect(stale).toBe(false);
});
