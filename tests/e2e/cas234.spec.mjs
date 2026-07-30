// CAS-234: the count appears twice per step, not three times.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

const COUNT_LINE = /\d+\s+films?\s+match right now/i;

test("CAS-234: no step prints the count a third time at the foot of the page", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);

  for(const step of ["selectivity", "genres", "language", "age", "years"]){
    await page.evaluate(k => window.gotoStep(k, "none"), step);
    const foot = await page.locator("#onbStep .ossumline").allTextContents();
    for(const line of foot){
      expect(line, `${step}: the foot of the page still quotes the count — "${line.trim()}"`)
        .not.toMatch(COUNT_LINE);
    }
    // …and the two places that SHOULD carry it still do.
    const top = await page.locator("#onbStepCount").count();
    const cta = await page.locator(".oscta").first().textContent();
    expect(top + (COUNT_LINE.test(cta || "") || /\d/.test(cta || "") ? 1 : 0),
      `${step}: the count vanished from the top and the button too`).toBeGreaterThan(0);
  }
});

test("CAS-234: the description survives, and Mission keeps its set-aside explanation", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);

  await page.evaluate(() => window.gotoStep("genres", "none"));
  await expect(page.locator("#onbStepSay")).toContainText(/Drawing from/);
  await page.evaluate(() => window.gotoStep("language", "none"));
  await expect(page.locator("#onbStepSay")).toContainText(/Watching in/);
  await page.evaluate(() => window.gotoStep("age", "none"));
  await expect(page.locator("#onbStepSay")).toContainText(/Including/);
  await page.evaluate(() => window.gotoStep("years", "none"));
  await expect(page.locator("#onbStepSay")).toContainText(/Going back/);

  // Mission drops the recap sentence entirely; the set-aside note is a different claim and stays when
  // there is one to make.
  await page.evaluate(() => window.gotoStep("selectivity", "none"));
  await expect(page.locator("#onbSelSay")).not.toContainText(/Films that are/);
  const aside = await page.evaluate(() => ({ n: selSetAside(), html: selSayHtml() }));
  if(aside.n) expect(aside.html).toMatch(/no score yet/);
  else expect(aside.html).toBe("");
});
