// CAS-306: the priority screen's two option boxes (.priobtn.cin / .priobtn.str) sat in a flex column, so
// each box was only ever as tall as its own content — and only the streaming label wraps to two lines,
// which left the cinema box visibly shorter. Moving the container to a two-row CSS grid makes both boxes
// share the taller box's height even though only one label wraps.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-306: the two viewing-priority boxes render at equal height and width", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();

  const [cin, str] = await page.locator(".priobtn").evaluateAll(els =>
    els.map(el => el.getBoundingClientRect()).map(r => ({ width: r.width, height: r.height }))
  );

  expect(cin.height, "cinema box height should match streaming box height").toBeCloseTo(str.height, 0);
  expect(cin.width, "cinema box width should match streaming box width").toBeCloseTo(str.width, 0);
});
