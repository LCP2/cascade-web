// CAS-261: a cinema agent is Scale + Buzz, and is not offered a standard its lane cannot apply.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, PRESET_NAMES } from "./helpers.mjs";

test("CAS-261: Nominees & Awards is off the cinema shortlist, and still on the streaming one", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cinema = (await shortlistCards(page)).map(c => c.name);
  expect(cinema).toEqual(PRESET_NAMES.cinema);
  expect(cinema.join(" | ")).not.toMatch(/Nominees & Awards/);

  await toShortlist(page, "stream");
  const stream = (await shortlistCards(page)).map(c => c.name);
  expect(stream.join(" | ")).toMatch(/Nominees & Awards/);
});

test("CAS-261: the cinema Mission screen offers Scale and Buzz and nothing else", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  const dials = await page.evaluate(() => ({
    used: MISSION_DIALS_USED[missionKind()],
    rest: missionRest(),
    kind: missionKind(),
  }));
  expect(dials.kind).toBe("cinema");
  expect(dials.used.slice().sort()).toEqual(["buzz", "scale"]);
  expect(dials.rest, "cinema has a 'More controls' set again").toEqual([]);
  // …and no hidden control is on screen either.
  await expect(page.locator(".osinner", { hasText: "People's vote" })).toHaveCount(0);
  await expect(page.locator(".osinner", { hasText: "Critics & awards" })).toHaveCount(0);
});

test("CAS-261: no cinema agent carries a criterion its lane cannot show", async ({ page }) => {
  await toShortlist(page, "cinema");
  for(const name of PRESET_NAMES.cinema){
    await toShortlist(page, "cinema");
    await pickCard(page, name);
    const d = await page.evaluate(() => {
      const a = onbApply();
      return { kind: a.kind, crowd: a.selCrowd, crit: a.selCritScore, awards: a.selAwards };
    });
    expect(d.kind).toBe("cinema");
    expect(d.crowd, `${name} carries a People's-vote floor`).toBe(0);
    expect(d.crit, `${name} carries a critics-score floor`).toBe(0);
    expect(d.awards, `${name} carries an awards rung`).toBe(0);
  }
});

test("CAS-261: a cinema card promises only the bar it applies", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cinema = page.locator(".scard", { has: page.locator(".sc-name", { hasText: "Date Night" }) });
  await expect(cinema.locator(".sc-chan")).toContainText("A little buzz");
  await expect(cinema.locator(".sc-chan")).not.toContainText("Well-liked");

  await toShortlist(page, "stream");
  const stream = page.locator(".scard", { has: page.locator(".sc-name", { hasText: "Date Night" }) });
  await expect(stream.locator(".sc-chan")).toContainText("Well-liked");
});

test("CAS-261: a cinema agent saved with the old dials is corrected on load", async ({ page }) => {
  await toShortlist(page, "cinema");
  const fixed = await page.evaluate(() => {
    const c = normCascade({ kind: "cinema", selCrowd: 7.5, selCritScore: 80, selAwards: 3, selBuzz: 1 });
    return { crowd: c.selCrowd, crit: c.selCritScore, awards: c.selAwards, buzz: c.selBuzz };
  });
  expect(fixed).toEqual({ crowd: 0, crit: 0, awards: 0, buzz: 1 });
});
