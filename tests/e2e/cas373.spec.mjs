// CAS-373: the film card is tightened for mobile — the text column is sized/clamped to end level with the
// poster, the Landmark/Anticipated badge moves to its own row under the poster with the awards chips beside
// it (row-aligned, never wrapping), the services line and the Watch/Agent/Watched row both shrink, the card
// gets a brighter hairline border, and the collapsed title truncates to one line without ever losing its
// rating badge.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page, kind = "stream"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator("#groups .card").first()).toBeVisible();
}

test("CAS-373: the scores row never overflows past the poster's bottom", async ({ page }) => {
  await toAgentListing(page);
  const { checked, overflows } = await page.evaluate(() => {
    let n = 0; const bad = [];
    document.querySelectorAll("#groups .card:not(.expanded)").forEach(card => {
      const poster = card.querySelector(".poster"), scores = card.querySelector(".r-scores");
      if(!poster || !scores) return;
      n++;
      const over = scores.getBoundingClientRect().bottom - poster.getBoundingClientRect().bottom;
      if(over > 8) bad.push({ id: card.id, over: Math.round(over) });
    });
    return { checked: n, overflows: bad };
  });
  expect(checked, "no card had both a poster and a scores row to check").toBeGreaterThan(0);
  expect(overflows, "the scores row ran past the bottom of the poster").toEqual([]);
});

test("CAS-373: on a long-synopsis card, the scores row bottom lands close to the poster bottom", async ({ page }) => {
  await toAgentListing(page);
  const gaps = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("#groups .card:not(.expanded)").forEach(card => {
      const syn = card.querySelector(".synopsis");
      if(!syn || syn.scrollHeight <= syn.clientHeight + 1) return;   // only the clamped (3-line) cards
      const poster = card.querySelector(".poster"), scores = card.querySelector(".r-scores");
      if(!poster || !scores) return;
      out.push(poster.getBoundingClientRect().bottom - scores.getBoundingClientRect().bottom);
    });
    return out;
  });
  test.skip(gaps.length === 0, "no card in this listing has a synopsis long enough to be clamped");
  // "no big gap" — a clamped (fullest) card's text column should end within a few px of the poster, not
  // dozens of px short of it.
  for(const g of gaps) expect(Math.abs(g), `poster/scores bottoms are ${g}px apart`).toBeLessThan(10);
});

test("CAS-373: the badge sits directly under the poster, on the poster's own column", async ({ page }) => {
  await toAgentListing(page);
  const rows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("#groups .card:not(.expanded)").forEach(card => {
      const badge = card.querySelector(".r-badge");
      if(!badge || !badge.textContent.trim()) return;
      const poster = card.querySelector(".poster");
      const b = badge.getBoundingClientRect(), p = poster.getBoundingClientRect();
      out.push({ leftDiff: Math.abs(b.left - p.left), top: b.top, posterBottom: p.bottom });
    });
    return out;
  });
  test.skip(rows.length === 0, "no card in this listing carries a scale badge");
  for(const r of rows){
    expect(r.leftDiff, "the badge is not left-aligned with the poster").toBeLessThan(3);
    expect(r.top, "the badge sits above the poster's own bottom, not below it").toBeGreaterThanOrEqual(r.posterBottom - 2);
  }
});

test("CAS-373: the awards row is column-aligned with IMDb and row-aligned with the badge", async ({ page }) => {
  await toAgentListing(page);
  const rows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("#groups .card:not(.expanded)").forEach(card => {
      const awards = card.querySelector(".r-awards");
      const scores = card.querySelector(".r-scores");
      if(!awards || !awards.textContent.trim() || !scores) return;
      const a = awards.getBoundingClientRect(), sc = scores.getBoundingClientRect();
      const badge = card.querySelector(".r-badge");
      const badgeTop = badge && badge.textContent.trim() ? badge.getBoundingClientRect().top : null;
      out.push({ leftDiff: Math.abs(a.left - sc.left), top: a.top, badgeTop });
    });
    return out;
  });
  test.skip(rows.length === 0, "no card in this listing carries an award chip");
  for(const r of rows){
    expect(r.leftDiff, "the awards row does not start at the IMDb column's left edge").toBeLessThan(3);
    if(r.badgeTop != null)
      expect(Math.abs(r.top - r.badgeTop), "the awards row is not on the same row as the badge").toBeLessThan(4);
  }
});

test("CAS-373: the awards row never wraps onto a second line", async ({ page }) => {
  await toAgentListing(page);
  const wrapped = await page.evaluate(() => {
    let n = 0;
    document.querySelectorAll("#groups .card .r-awards").forEach(row => {
      if(!row.textContent.trim()) return;
      const chips = [...row.children];
      if(chips.length < 2) return;
      const tops = new Set(chips.map(c => Math.round(c.getBoundingClientRect().top)));
      if(tops.size > 1) n++;
    });
    return n;
  });
  expect(wrapped, "at least one awards row wrapped its chips onto more than one line").toBe(0);
});

test("CAS-373: the services line never wraps onto a second line", async ({ page }) => {
  await toAgentListing(page);
  const { checked, wrapped } = await page.evaluate(() => {
    let n = 0, w = 0;
    document.querySelectorAll("#groups .card .savetxt").forEach(el => {
      n++;
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
      if(el.scrollHeight > lh * 1.4) w++;
    });
    return { checked: n, wrapped: w };
  });
  test.skip(checked === 0, "no card in this listing carries a services line");
  expect(wrapped, "the services line wrapped onto a second line").toBe(0);
});

test("CAS-373: the Watch/Agent/Watched controls are shorter than the old 38px row", async ({ page }) => {
  await toAgentListing(page);
  const height = await page.evaluate(() =>
    document.querySelector("#groups .card .cmini").getBoundingClientRect().height);
  expect(height, `the control row is ${height}px tall`).toBeLessThan(38);
  expect(height, `the control row is ${height}px tall — too short to tap`).toBeGreaterThan(24);
});

test("CAS-373: every card carries a brighter-than-panel border", async ({ page }) => {
  await toAgentListing(page);
  const { borderColor, panelColor } = await page.evaluate(() => {
    const card = document.querySelector("#groups .card");
    return {
      borderColor: getComputedStyle(card).borderTopColor,
      panelColor: getComputedStyle(card).backgroundColor,
    };
  });
  const rgb = s => (s.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  expect(lum(rgb(borderColor)), `border ${borderColor} vs panel ${panelColor}`).toBeGreaterThan(lum(rgb(panelColor)) + 10);
});

test("CAS-373: the collapsed title stays on one line and never loses its rating badge", async ({ page }) => {
  await toAgentListing(page);
  const { checked, bad } = await page.evaluate(() => {
    let n = 0; const bad = [];
    document.querySelectorAll("#groups .card:not(.expanded)").forEach(card => {
      const text = card.querySelector(".titletext");
      if(!text) return;
      n++;
      const lh = parseFloat(getComputedStyle(text).lineHeight) || 20;
      if(text.scrollHeight > lh * 1.4) bad.push({ id: card.id, why: "title wrapped" });
      const cert = card.querySelector(".cert");
      if(cert){
        const t = text.getBoundingClientRect(), c = cert.getBoundingClientRect();
        // the badge must sit on the title's own line, not pushed below it
        if(Math.abs(t.top - c.top) > 6) bad.push({ id: card.id, why: "rating badge off the title line" });
      }
    });
    return { checked: n, bad };
  });
  expect(checked, "no collapsed card had a title to check").toBeGreaterThan(0);
  expect(bad).toEqual([]);
});

test("CAS-373: expanding a card shows the full title, wrapped if it needs to be", async ({ page }) => {
  await toAgentListing(page);
  const card = page.locator("#groups .card").first();
  const fullTitle = await card.locator(".titletext").textContent();
  await card.locator(".title").click();
  await expect(card).toHaveClass(/expanded/);
  const shown = await card.locator(".titletext").evaluate(el => {
    const cs = getComputedStyle(el);
    return { text: el.textContent, whiteSpace: cs.whiteSpace };
  });
  expect(shown.text).toBe(fullTitle);
  expect(shown.whiteSpace).toBe("normal");
});
