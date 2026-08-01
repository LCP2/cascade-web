// CAS-245: the per-film Notify panel — a row per window the agent HAS, and a close on the left pointing right.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toFirstCard(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-245: the Notify chip opens a row per window, defaulting to the agent's own answer", async ({ page }) => {
  const card = await toFirstCard(page, "cinema");
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  await expect(pop).toBeVisible();

  // A cinema agent's own windows, and nothing from the other type.
  // CAS-280 narrowed this: the panel now offers only the moments THIS film can still reach, so which rows
  // appear depends on where the film is. A film already in cinemas has left Upcoming behind, and with it the
  // announced / opening-next-week sub-moments — this test used to assert all four unconditionally.
  const rows = await pop.locator(".nopt").allTextContents();
  const joined = rows.join(" | ");
  expect(rows.length, "a cinema agent's first card should still be offered something").toBeGreaterThan(0);
  expect(joined).toMatch(/Upcoming|In cinema/);
  expect(joined, "a cinema agent must not be offered a home window").not.toMatch(/Streaming|Standard Rent/);
  // Whatever IS offered must be a moment the film can still reach.
  const spent = await page.evaluate(() => {
    const id = +document.querySelector("#groups .card").id.replace("card-", "");
    const rung = STATUS_RUNG[primaryStatus(MOVIES.find(m => m.tmdb_id === id))];
    return notifyOptionsFor(null, id)
      .filter(o => (WINDOW_RUNG[o.key.split(".")[0]] ?? 99) < rung).length;
  });
  expect(spent, "an already-passed moment is on the panel").toBe(0);

  // Everything the agent has switched on starts ON for the film.
  for(const n of await pop.locator(".nopt").all()) await expect(n).toHaveAttribute("aria-pressed", "true");

  // Turning one off is remembered and shown on the chip.
  // CAS-280 means the panel can hold a single row for this film, in which case switching it off leaves
  // nothing armed — and the chip correctly says "Muted" rather than counting to zero. Both readings are
  // truthful; which one you get depends on how many moments the film has left.
  const rowCount = await pop.locator(".nopt").count();
  await pop.locator(".nopt").first().click();
  await expect(card.locator(".ctl.notify"))
    .toContainText(rowCount > 1 ? /Notify · \d/ : /Muted/);
  const state = await page.evaluate(() => {
    const id = +document.querySelector("#groups .card").id.replace("card-", "");
    return notify[id] && notify[id].wins;
  });
  expect(Object.values(state || {}).some(v => v === false), "the choice was not stored").toBe(true);
});

test("CAS-245: the close sits on the LEFT and points RIGHT, the mirror of Watch status", async ({ page }) => {
  const card = await toFirstCard(page, "cinema");

  await card.locator(".ctl.notify").click();
  const notifyGeom = await card.locator(".cpop.npop").evaluate(pop => {
    const close = pop.querySelector(".cclose"), body = pop.querySelector(".nopts");
    return { close: close.getBoundingClientRect().left, body: body.getBoundingClientRect().left,
             rotate: getComputedStyle(close.querySelector("svg")).transform };
  });
  expect(notifyGeom.close, "the Notify close must be left of its options").toBeLessThan(notifyGeom.body);
  expect(notifyGeom.rotate, "a down chevron must be rotated to point somewhere").not.toBe("none");

  // …and the Watch-status panel is the other way round, which is the contrast the ticket asks for.
  await page.keyboard.press("Escape");
  await card.locator(".ctl.watch").click();
  const watchGeom = await card.locator(".cpop").evaluate(pop => {
    const close = pop.querySelector(".cclose"), body = pop.querySelector(".csegs");
    return { close: close.getBoundingClientRect().left, body: body.getBoundingClientRect().left };
  });
  expect(watchGeom.close, "the Watch-status close must be right of its options").toBeGreaterThan(watchGeom.body);
});

test("CAS-245: a window the agent does not watch is still offered, and says so", async ({ page }) => {
  const card = await toFirstCard(page, "stream");
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  const rows = await pop.locator(".nopt").allTextContents();
  // CAS-280: Premium is only offered while the film has not already passed it, so pick a card that still can.
  test.skip(!rows.join(" | ").match(/Premium/),
    "this agent's first card has already passed the Premium window (CAS-280)");
  // Premium is off for a new streaming agent (CAS-243), so its row is off and labelled as outside the agent.
  const premium = pop.locator(".nopt", { hasText: "Premium" });
  await expect(premium).toHaveAttribute("aria-pressed", "false");
  await expect(premium.locator(".notag")).toHaveText(/not in this agent/i);
  // …and opting this one film in is exactly what the control is for.
  await premium.click();
  await expect(premium).toHaveAttribute("aria-pressed", "true");
});
