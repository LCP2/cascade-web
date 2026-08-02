// CAS-280: the per-film Notify list offers only the moments that film can still reach.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, freshApp } from "./helpers.mjs";

test("CAS-280: no film is offered a window it has already left", async ({ page }) => {
  await freshApp(page);
  // Checked against the engine directly so every window in the catalogue is covered, not just the ones
  // one agent happens to list today.
  const bad = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for(const m of MOVIES){
      const w = primaryStatus(m);
      if(seen.has(w)) continue;
      seen.add(w);
      const rung = STATUS_RUNG[w];
      if(rung === undefined) continue;
      for(const o of notifyOptionsFor(null, m.tmdb_id)){
        const base = o.key.split(".")[0];
        // Strictly below the film's own rung is unambiguously spent: it cannot arrive somewhere it has left.
        if((WINDOW_RUNG[base] ?? 99) < rung) out.push({ title: m.title, window: w, offered: o.key });
      }
    }
    return out;
  });
  expect(bad, `offered a window already left: ${JSON.stringify(bad)}`).toEqual([]);
});

test("CAS-280: a row level with the film survives only if it carries a real future moment", async ({ page }) => {
  await freshApp(page);
  const bad = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for(const m of MOVIES){
      const w = primaryStatus(m);
      if(seen.has(w)) continue;
      seen.add(w);
      const rung = STATUS_RUNG[w];
      if(rung === undefined) continue;
      for(const o of notifyOptionsFor(null, m.tmdb_id)){
        const base = o.key.split(".")[0];
        if((WINDOW_RUNG[base] ?? 99) !== rung) continue;
        // Level with the film. Allowed ONLY when the row fires on something other than its own arrival —
        // "In cinema" fires on past-opening-weekend, "Upcoming" fires on reaching a cinema.
        const win = Object.values(AGENT_WINDOWS).flat().find(x => x.key === base);
        const own = new Set(win.status || []);
        const arrivalOnly = Object.keys(win.alerts || {}).every(a => own.has(a));
        if(arrivalOnly) out.push({ title: m.title, window: w, offered: o.key });
      }
    }
    return out;
  });
  expect(bad, `offered its own arrival, which has already happened: ${JSON.stringify(bad)}`).toEqual([]);
});

test("CAS-280: the ticket's own example — a film in Purchase is offered only Rent and Stream", async ({ page }) => {
  await freshApp(page);
  const result = await page.evaluate(() => {
    const m = MOVIES.find(x => primaryStatus(x) === "pvod");
    if(!m) return null;
    return notifyOptionsFor(null, m.tmdb_id).map(o => o.key);
  });
  test.skip(result === null, "no film is in the Premium window today");
  expect(result).not.toContain("upcoming");
  expect(result).not.toContain("in_cinema");
  expect(result).not.toContain("premium");
  expect(result).toContain("rent");
  expect(result).toContain("stream");
});

test("CAS-280: a film at the last window is offered nothing at all", async ({ page }) => {
  await freshApp(page);
  const keys = await page.evaluate(() => {
    const m = MOVIES.find(x => primaryStatus(x) === "included_streaming");
    return m ? notifyOptionsFor(null, m.tmdb_id).map(o => o.key) : null;
  });
  test.skip(keys === null, "no film is on streaming today");
  expect(keys, "streaming is the end of the journey — there is nothing after it").toEqual([]);
});

test("CAS-280: an upcoming film still gets the whole ladder", async ({ page }) => {
  await freshApp(page);
  const keys = await page.evaluate(() => {
    const m = MOVIES.find(x => primaryStatus(x) === "upcoming");
    return m ? notifyOptionsFor(null, m.tmdb_id).map(o => o.key.split(".")[0]) : null;
  });
  test.skip(keys === null, "no upcoming film today");
  // It has passed nothing, so everything after "upcoming" is still ahead of it.
  for(const k of ["in_cinema", "premium", "rent", "stream"]) expect(keys).toContain(k);
  // …and "Upcoming" itself survives, deliberately: that row does not fire on becoming upcoming, it fires
  // when the film REACHES A CINEMA, which is the most future thing there is for an unreleased film.
  expect(keys).toContain("upcoming");
});

test("CAS-280: the chip's count describes only reachable moments", async ({ page }) => {
  await freshApp(page);
  const ok = await page.evaluate(() => {
    const m = MOVIES.find(x => primaryStatus(x) === "rental");
    if(!m) return null;
    const st = filmNotifyState(m.tmdb_id);
    return st.total === notifyOptionsFor(null, m.tmdb_id).length;
  });
  test.skip(ok === null, "no rental film today");
  expect(ok, "the chip counted moments the film had already passed").toBe(true);
});

test("CAS-280: the panel says so rather than opening empty", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  // Find a listed film that is already at the end of the ladder.
  const cardId = await page.evaluate(() => {
    const el = [...document.querySelectorAll("#groups .card")].find(c => {
      const id = Number(c.id.replace("card-", ""));
      return notifyOptionsFor(null, id).length === 0;
    });
    return el ? el.id : null;
  });
  test.skip(!cardId, "no listed film has run out of moments today");

  await page.locator(`#${cardId} .ctl.notify`).click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  await expect(page.locator(".cpop.npop .nonone")).toBeVisible();
  await expect(page.locator(".cpop.npop .nopt:not(.nonone)")).toHaveCount(0);
});
