// CAS-235: the build stamp on the page is the version in VERSION.
import { test, expect } from "@playwright/test";

test("CAS-235: the shipped build says 0.8.2, on the page and in version.json", async ({ page, request }) => {
  await page.goto("/index.html");
  const info = await page.evaluate(() => BUILD_INFO);
  expect(info.version).toBe("0.8.2");
  expect([info.major, info.minor, info.patch]).toEqual([0, 8, 2]);

  // …and the file a machine reads agrees with the page a person reads.
  const served = await (await request.get("/version.json")).json();
  expect(served.version).toBe(info.version);
  expect([served.major, served.minor, served.patch]).toEqual([info.major, info.minor, info.patch]);
  expect(served.build).toBe(info.build);

  // The footer prints it too, so a version bump that never reached the build is visible without a devtool.
  await expect(page.locator("body")).toContainText(/0\.8\.2/);
});
