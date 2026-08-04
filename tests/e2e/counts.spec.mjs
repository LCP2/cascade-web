// CAS-232 part A + B: one agent, one number — and the number is the length of the list.
//
// This is the suite that would have caught CAS-221 on the way in. The bug was not a wrong count; it was two
// screens answering the same question differently (21 on the card, 2 on Mission) because they were measuring
// different populations. No unit test would have seen it, because each function was right on its own terms.
import { test, expect } from "@playwright/test";
import {
  toShortlist, shortlistCards, pickCard, topCount, ctaCount, finishFlow, toListing,
  settleListing, sectionCounts, numberIn,
} from "./helpers.mjs";

for(const kind of ["cinema", "stream"]){
  test(`${kind}: the count on the card is the count everywhere after it`, async ({ page }) => {
    await toShortlist(page, kind);

    const cards = await shortlistCards(page);
    expect(cards.length).toBeGreaterThan(1);

    // The recommended preset is the one most people will take, so it is the one walked end to end.
    const lead = cards[0];
    const cardCount = numberIn(lead.countText);
    // A preset that catches nothing says so in words instead of printing 0 — an honest state, and not one this
    // assertion can compare, so it is skipped rather than fudged.
    test.skip(cardCount == null, `${lead.name} catches nothing today: "${lead.countText}"`);

    await pickCard(page, lead.name);

    const mission = await topCount(page);
    const cta = await ctaCount(page);
    expect(mission, "Mission's own count must equal the card's").toBe(cardCount);
    expect(cta, "Continue must equal Mission").toBe(cardCount);

    // …and it must hold for the rest of the flow, not just its first screen.
    const reveal = await finishFlow(page);
    expect(reveal, "the reveal must equal the count that got you there").toBe(cardCount);

    await toListing(page);
    const sections = await sectionCounts(page);
    const listed = sections.reduce((a, s) => a + s.count, 0);
    // The listing shows the films that have ARRIVED in a window the agent lists. The haul is everything the
    // agent follows, and following a film starts before it arrives — a streaming agent watches a film that is
    // still in cinemas precisely so it can tell you the day it lands. So the listing is a subset of the haul,
    // never a superset, and the two coincide only when nothing the agent follows is still upstream of it.
    //
    // This asserted equality until CAS-237, and passed only by luck: every other preset already had a gap
    // (stream/streaming listed 248 of 250) and the lead card happened not to. Once the window estimator was
    // fixed and films could be in a cinema again, two of the lead card's films were legitimately still on a
    // screen and the coincidence broke. The subset relation is the property that was always true.
    expect(listed, `sections ${JSON.stringify(sections)} against a haul of ${cardCount}`)
      .toBeLessThanOrEqual(cardCount);
    expect(listed, `the listing is empty against a haul of ${cardCount}`).toBeGreaterThan(0);
  });

  test(`${kind}: every preset's card count agrees with its own Mission page`, async ({ page }) => {
    await toShortlist(page, kind);
    const cards = await shortlistCards(page);
    for(const c of cards){
      const want = numberIn(c.countText);
      if(want == null) continue;                       // "nothing yet" — no number to compare
      await toShortlist(page, kind);                   // back to a clean shortlist for each card
      await pickCard(page, c.name);
      expect(await topCount(page), `${c.name}: card said ${want}`).toBe(want);
      expect(await ctaCount(page), `${c.name}: Continue disagrees with Mission`).toBe(want);
    }
  });
}

test("the listing renders exactly as many rows as it claims", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const rendered = await settleListing(page);
  const sections = await sectionCounts(page);
  const claimed = sections.reduce((a, s) => a + s.count, 0);
  expect(rendered, `${claimed} claimed, ${rendered} rows on the page`).toBe(claimed);
});

test("every card's window chip is the window its data puts it in", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  // The card's lit availability slot has to be the film's real current window. This is CAS-155 as a UI
  // assertion: a film filed under the wrong stage shows the wrong slot lit, and no count would notice.
  const result = await page.evaluate(() => {
    // The lit cell of the availability strip is `.avail .win.on`, and its label is the `.wpill` inside it. The
    // first cell is the cinema slot and is tri-state (Upcoming / Opening / Cinema); the other three are fixed.
    const SLOT = { upcoming:"Upcoming", opening_week:"Opening", in_cinema:"Cinema",
                   pvod:"Buy", rental:"Rent", included_streaming:"Stream" };
    const out = [], checked = [];
    for(const card of document.querySelectorAll("#groups .card")){
      const id = Number(card.id.replace("card-", ""));
      const m = MOVIES.find(x => x.tmdb_id === id);
      if(!m) { out.push({ id, why: "card has no film behind it" }); continue; }
      const lit = card.querySelector(".avail .win.on .wpill");
      if(!lit) { out.push({ title: m.title, why: "no window is lit on this card" }); continue; }
      const want = SLOT[primaryStatus(m)];
      const got = (lit.textContent || "").trim();
      checked.push(m.title);
      if(want && got.toLowerCase() !== want.toLowerCase())
        out.push({ title: m.title, status: primaryStatus(m), want, got });
    }
    return { out, checked: checked.length };
  });
  // A silent pass because the selector matched nothing is the failure mode this assertion is most exposed to —
  // and it happened on the first run, so the count of cards actually inspected is asserted too.
  expect(result.checked, "no card's window was inspected — has the strip's markup changed?").toBeGreaterThan(5);
  expect(result.out, JSON.stringify(result.out.slice(0, 5))).toEqual([]);
});
