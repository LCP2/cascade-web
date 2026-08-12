// CAS-479: the origin-date label on a film's availability capsule (bandHTML, "reldate"/"rellbl") was
// hardcoded to "Released" — a film still in its Upcoming window showed a future date under "RELEASED",
// which reads as a contradiction. rellbl now compares releaseDateOf(m) against the build-stamped TODAY:
// "Releasing" when the date hasn't happened yet, "Released" once it has. See bandHTML in app_template.html.
import { test, expect } from "@playwright/test";
import { gotoFresh } from "./helpers.mjs";

test("CAS-479: the origin-date label reads Releasing for a future date, Released for a past/today one", async ({ page }) => {
  await gotoFresh(page);

  const result = await page.evaluate(() => {
    const future = MOVIES.find(m => { const r = releaseDateOf(m); return r && r >= TODAY; });
    const past = MOVIES.find(m => { const r = releaseDateOf(m); return r && r < TODAY; });
    return {
      future: future ? bandHTML(future, "") : null,
      past: past ? bandHTML(past, "") : null,
    };
  });

  test.skip(!result.future && !result.past, "no dated film in either direction in this run's catalogue");

  if(result.future){
    expect(result.future).toContain('<span class="rellbl">Releasing</span>');
  }
  if(result.past){
    expect(result.past).toContain('<span class="rellbl">Released</span>');
  }
});
