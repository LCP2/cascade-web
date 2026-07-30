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

  // A cinema agent's own windows and sub-moments, and nothing from the other type.
  const rows = await pop.locator(".nopt").allTextContents();
  expect(rows.join(" | ")).toMatch(/Upcoming/);
  expect(rows.join(" | ")).toMatch(/In cinema/);
  expect(rows.join(" | ")).toMatch(/When announced/);
  expect(rows.join(" | ")).toMatch(/Opening next week/);
  expect(rows.join(" | "), "a cinema agent must not be offered a home window").not.toMatch(/Streaming|Standard Rent/);

  // Everything the agent has switched on starts ON for the film.
  for(const n of await pop.locator(".nopt").all()) await expect(n).toHaveAttribute("aria-pressed", "true");

  // Turning one off is remembered and shown on the chip.
  await pop.locator(".nopt").first().click();
  await expect(card.locator(".ctl.notify")).toContainText(/Notify · \d/);
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
  expect(rows.join(" | ")).toMatch(/Premium/);
  // Premium is off for a new streaming agent (CAS-243), so its row is off and labelled as outside the agent.
  const premium = pop.locator(".nopt", { hasText: "Premium" });
  await expect(premium).toHaveAttribute("aria-pressed", "false");
  await expect(premium.locator(".notag")).toHaveText(/not in this agent/i);
  // …and opting this one film in is exactly what the control is for.
  await premium.click();
  await expect(premium).toHaveAttribute("aria-pressed", "true");
});
