// CAS-909: the onboarding v2 agent reveal — the app's own Agents-screen row (renderAgentsScreen's .agrow),
// minus the reorder grip and Edit button, shown for each of the four ONB_AGENTS_V2 recipes. Preview-only,
// reached via ?step=v2_massive/v2_favs/v2_date/v2_family — none of this is wired into FLOWS yet (CAS-911).
// Follows CAS-885's own goto-twice technique (config.js 404'd for guest/network-free mode, then a real
// navigation to the target URL after localStorage is seeded) since the answers this ticket reads
// (onbAnswersV2Load(), keyed "cascade_onb_answers_v2") are read at BOOT, synchronously, before any test
// code could reach in and set them post-navigation.
import { test, expect } from "@playwright/test";

const ANSWERS_V2_KEY = "cascade_onb_answers_v2";

/** A guest, network-free boot landed directly on a v2 reveal step, with `answers` already seeded under
 * the v2 answers key so the step's own wire() (onbAnswersV2Load()) picks them up on this exact boot. */
async function openReveal(page, stepKey, answers){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  const url = `/index.html?step=${stepKey}`;
  await page.goto(url);
  await page.evaluate(a => {
    try{ localStorage.clear(); }catch(e){}
    try{ localStorage.setItem("cascade_onb_answers_v2", JSON.stringify(a)); }catch(e){}
  }, answers);
  await page.goto(url);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  return page.locator("#onbStep .agrow");
}

/** The same watchCount() the app itself reads, called fresh against the same recipe the reveal is
 * currently showing — an independent read, not a scrape of what the DOM already printed. */
async function expectedWatchCount(page, template){
  return page.evaluate(t => {
    const c = buildOnbAgentsV2(onbFlow.answersV2).find(a => a.template === t);
    return c ? watchCount(c) : null;
  }, template);
}

const MASSIVE_ANSWERS = { cinema: "yes", rent: "no" };
const FAVS_ANSWERS = { cinema: "yes", styles: ["Thriller", "Drama"], selScale: 15000000, ages: ["M", "MA 15+"] };
const DATE_ANSWERS = { cinema: "yes", partner: "yes", partnerDiff: "no", styles: ["Thriller", "Drama"] };
const FAMILY_ANSWERS = { cinema: "yes", kids: "yes" };

test("CAS-909 AC2: v2_massive renders exactly one .agrow, ranked 1, with no grip and no Edit button", async ({ page }) => {
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  await expect(row).toHaveCount(1);
  await expect(row.locator(".agrank")).toHaveText("1");
  await expect(page.locator(".aggrip")).toHaveCount(0);
  await expect(page.locator(".ag-edit")).toHaveCount(0);
});

test("CAS-909 AC3: v2_massive's settings grid is exactly SCORE/AUDIENCE/NOTIFY, and SCORE reads a dotted 90+ in cinema", async ({ page }) => {
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  const labels = await row.locator(".agslbl").allInnerTexts();
  expect(labels).toEqual(["SCORE", "AUDIENCE", "NOTIFY"]);

  const scoreVal = row.locator(".agsrow", { has: page.locator(".agslbl", { hasText: "SCORE" }) }).locator(".agsval");
  await expect(scoreVal.locator(".agdot")).toHaveCount(1);
  await expect(scoreVal).toContainText("90+ in cinema");
});

test("CAS-909 AC4: v2_favs' settings grid is exactly STYLES/SCORE/BUDGET/AUDIENCE/NOTIFY", async ({ page }) => {
  const row = await openReveal(page, "v2_favs", FAVS_ANSWERS);
  const labels = await row.locator(".agslbl").allInnerTexts();
  expect(labels).toEqual(["STYLES", "SCORE", "BUDGET", "AUDIENCE", "NOTIFY"]);
});

test("CAS-909 AC5: no .agsval reads bare Any or Any style, in any of the four reveals", async ({ page }) => {
  const cases = [
    ["v2_massive", MASSIVE_ANSWERS],
    ["v2_favs", FAVS_ANSWERS],
    ["v2_date", DATE_ANSWERS],
    ["v2_family", FAMILY_ANSWERS],
  ];
  for(const [stepKey, answers] of cases){
    const row = await openReveal(page, stepKey, answers);
    const values = await row.locator(".agsval").allInnerTexts();
    for(const v of values){
      expect(v.trim()).not.toBe("Any");
      expect(v.trim()).not.toBe("Any style");
    }
  }
});

test("CAS-909 AC6: .agmstat.total reads N movies, matching watchCount() computed independently", async ({ page }) => {
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  const totalText = (await row.locator(".agmstat.total").innerText()).trim();
  expect(totalText).toMatch(/^\d+ movies$/);
  const shown = Number(totalText.match(/^(\d+) movies$/)[1]);
  const expected = await expectedWatchCount(page, "onb_massive");
  expect(expected).not.toBeNull();
  expect(shown).toBe(expected);
});

test("CAS-909 AC7: with reduced motion emulated, the row's animation is switched off", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const row = await openReveal(page, "v2_massive", MASSIVE_ANSWERS);
  const animationName = await row.evaluate(el => getComputedStyle(el).animationName);
  expect(animationName).toBe("none");
});
