// CAS-264: the flow carries every answer forward, so step six can still see step three.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, ctaLocator } from "./helpers.mjs";

/** The trail as [[label, value], …], in the order it is printed. Labels are upper-cased HERE because the
 *  screen upper-cases them in CSS, and textContent does not see text-transform. */
const trail = page => page.locator("#onbTrail .otrow").evaluateAll(rows => rows.map(r => [
  (r.querySelector(".otk")?.textContent || "").trim().toUpperCase(),
  (r.querySelector(".otv")?.textContent || "").trim(),
]));

const stepKey = page => page.evaluate(() => onbStepKey);

/** Press Continue and wait for the flow to land on the next step. */
async function next(page){
  const was = await stepKey(page);
  await ctaLocator(page).click();
  await page.waitForFunction(k => onbStepKey !== k, was);
  await page.waitForTimeout(500);   // let the slide settle
}

test("CAS-264: Mission shows its own summary under the boxes", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await page.waitForTimeout(500);

  const rows = await trail(page);
  const labels = rows.map(r => r[0]);
  expect(labels, "the trail is missing on the first step that has something to recap").toContain("MISSION");

  // It sits under the dials, not above them.
  const [lastDial, t] = await Promise.all([
    page.locator("#onbStepInner .osdial").last().boundingBox(),
    page.locator("#onbTrail").boundingBox(),
  ]);
  expect(t.y, "the summary is above the boxes it summarises").toBeGreaterThan(lastDial.y);

  // And it says what the dials are actually set to.
  const mission = rows.find(r => r[0] === "MISSION")[1];
  const live = await page.evaluate(() => hubBarSummary());
  expect(mission).toBe(live.replace(/&amp;/g, "&"));
  expect(mission, "Blockbusters sets a scale and a buzz rung, so neither should be empty").not.toBe("");
});

test("CAS-264: each later page carries the steps before it", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await page.waitForTimeout(500);

  const seen = [];
  for(let i = 0; i < 8; i++){
    const key = await stepKey(page);
    const rows = await trail(page);
    seen.push({ key, labels: rows.map(r => r[0]) });
    if(key === "notifysettings") break;
    await next(page);
  }

  // Style is after Mission, and shows it — the ticket's own example.
  const style = seen.find(s => s.key === "genres");
  expect(style, "the flow never reached the Style step").toBeTruthy();
  expect(style.labels, "the Style page does not carry the Mission selections").toContain("MISSION");
  expect(style.labels).toContain("STYLE");

  // The trail only ever grows as the line goes forward.
  for(let i = 1; i < seen.length; i++){
    expect(seen[i].labels.length,
      `${seen[i].key} shows fewer answers (${seen[i].labels.join(",")}) than ${seen[i-1].key}`)
      .toBeGreaterThanOrEqual(seen[i-1].labels.length);
  }
  // …and by the last screen the whole brief is on it.
  const last = seen[seen.length - 1];
  expect(last.labels).toEqual(expect.arrayContaining(["WATCHING", "AGENT", "MISSION", "NAME", "STYLE"]));
});

test("CAS-264: the newest answer is the one marked live", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await page.waitForTimeout(500);
  await next(page);   // Mission -> name

  const marked = (await page.locator("#onbTrail .otrow.now .otk").allTextContents()).map(s => s.trim().toUpperCase());
  expect(marked, "exactly one row should be marked as the step you are on").toEqual(["NAME"]);
  const rows = await trail(page);
  expect(rows[rows.length - 1][0], "the live row is not the last one").toBe("NAME");
});

test("CAS-264: the trail is live, not a snapshot taken when the step was left", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await page.waitForTimeout(500);
  await next(page);   // the Name step

  const before = (await trail(page)).find(r => r[0] === "NAME")[1];
  const field = page.locator("#onbStepInner input[type=text]").first();
  await field.fill("Friday Night");
  await page.waitForTimeout(200);
  const after = (await trail(page)).find(r => r[0] === "NAME")[1];

  expect(after, "renaming the agent did not move the row that names it").not.toBe(before);
  expect(after).toBe("Friday Night");
});

test("CAS-264: the streaming lane lists its own steps, not the cinema lane's", async ({ page }) => {
  await toShortlist(page, "stream");
  await pickCard(page, "Everyday Favourites");
  await page.waitForTimeout(500);
  const rows = await trail(page);
  expect(rows.find(r => r[0] === "WATCHING")[1]).toBe("My streaming services");
  // "How far back" and "Services" are streaming-only steps, so they cannot appear before they are walked.
  expect(rows.map(r => r[0])).not.toContain("SERVICES");
});
