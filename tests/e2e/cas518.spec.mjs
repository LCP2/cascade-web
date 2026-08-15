// CAS-518: the old app icon/header mark (rising bars + agent arc, gradient id "cg") is replaced by the
// "Cascading Frames" design — three fanned film frames with sprocket dots, a play triangle in the front
// frame, on a deep violet background — in both the favicon <link>s and the inline header .brandmark. The
// two must stay the same asset (per CAS-449 precedent: the header mark is favicon.svg's content, verbatim,
// proven legible at 26px), so this checks the new gradient ids are present and the old ones are gone in
// both places, and that the icon links still resolve.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

test("CAS-518: favicon <link>s point at the new icon and resolve", async ({ page }) => {
  await freshApp(page);
  await page.goto("/index.html");

  const hrefs = await page.evaluate(() => ({
    svg: document.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute("href"),
    png: document.querySelector('link[rel="icon"][type="image/png"]')?.getAttribute("href"),
    touch: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
  }));
  expect(hrefs).toEqual({ svg: "favicon.svg", png: "favicon.png", touch: "apple-touch-icon.png" });

  for(const href of [hrefs.svg, hrefs.png, hrefs.touch]){
    const res = await page.request.get(href);
    expect(res.ok()).toBe(true);
  }

  const svgBody = await (await page.request.get(hrefs.svg)).text();
  expect(svgBody).toContain("cbg");           // new background gradient
  expect(svgBody).toContain("cfg");           // new frame accent gradient
  expect(svgBody).not.toContain('id="cg"');   // old rising-bars gradient is gone
});

test("CAS-518: the header brandmark renders the same Cascading Frames design, not the old mark", async ({ page }) => {
  await freshApp(page);
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  const mark = page.locator("svg.brandmark");
  await expect(mark).toBeVisible();

  const markup = await mark.evaluate(el => el.outerHTML);
  expect(markup).toContain("cbg");
  expect(markup).toContain("cfg");
  expect(markup).not.toContain('id="cg"');
  // three sprocket-hole dots on the front frame + the play triangle path
  expect(await mark.locator("circle").count()).toBeGreaterThanOrEqual(9);
  expect(markup).toContain("<path");
});
