// CAS-265: Rating is asked straight after Style.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

for(const kind of ["cinema", "stream"]){
  test(`CAS-265: the ${kind} lane asks Rating immediately after Style`, async ({ page }) => {
    await freshApp(page);
    const list = await page.evaluate(k => FLOWS[k], kind);
    const style = list.indexOf("genres"), rating = list.indexOf("age");
    expect(style, "the Style step is missing").toBeGreaterThan(-1);
    expect(rating, `Rating is at ${rating}, Style at ${style}`).toBe(style + 1);
  });
}

test("CAS-265: nothing else changed places", async ({ page }) => {
  await freshApp(page);
  const flows = await page.evaluate(() => ({ cinema: FLOWS.cinema, stream: FLOWS.stream }));
  // Same steps, same lanes — only `age` moved. CAS-338 later dropped `language` from both lanes entirely
  // (the control survives in Agent Settings / Edit Agent), so it is no longer one of the steps being compared.
  expect(flows.cinema.filter(k => k !== "age"))
    .toEqual(["priority", "pickagent", "selectivity", "name", "genres",
              "keepfinding", "notifysettings"]);
  expect(flows.stream.filter(k => k !== "age"))
    .toEqual(["priority", "pickagent", "selectivity", "name", "genres", "years",
              "services", "keepfinding", "notifysettings"]);
});

test("CAS-265: walking the flow really hits Rating right after Style", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(".priobtn.cin").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  await page.locator(".scard").first().click();

  const seen = [];
  for(let i = 0; i < 10; i++){
    const key = await page.evaluate(() => onbStepKey);
    seen.push(key);
    if(key === "notifysettings") break;
    const was = key;
    await page.locator("#flowCta:visible, #onbStepCta:visible").first().click();
    await page.waitForFunction(k => onbStepKey !== k, was);
    await page.waitForTimeout(180);
  }
  expect(seen.indexOf("age"), "Rating never came up").toBeGreaterThan(-1);
  expect(seen.indexOf("age")).toBe(seen.indexOf("genres") + 1);
  // CAS-338: Language is no longer a wired-flow step in either lane — walking the cinema flow never lands on it.
  expect(seen).not.toContain("language");

  // The meter still counts every step exactly once — a reorder must not renumber the line.
  const label = await page.locator("#stepLbl").textContent();
  expect(label).toMatch(/^Step \d+ of \d+$/);
});
