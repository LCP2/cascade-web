// CAS-324: version.json is mirrored byte-for-byte from staging to main (promote.yml, CAS-312), so a
// build-time "env" value would always read whatever branch it was built on, even once mirrored to the
// other host. env must never be part of the committed/served stamp, on the page or in the raw file —
// only the runtime, hostname-derived badge may report it.
import { test, expect } from "@playwright/test";

test("CAS-324: env is never baked into the stamp; commit/version travel with the build", async ({ page, request }) => {
  await page.goto("/index.html");
  const info = await page.evaluate(() => BUILD_INFO);
  expect(info).not.toHaveProperty("env");
  expect(info.commit).toMatch(/^[0-9a-f]{7,40}$/);

  // The file a machine reads carries the same build-invariant fields as the page, and no env either.
  const served = await (await request.get("/version.json")).json();
  expect(served).not.toHaveProperty("env");
  expect(served.commit).toBe(info.commit);
  expect(served.build).toBe(info.build);
  expect(served.version).toBe(info.version);

  // The visible badge still resolves an env — from the hostname at runtime, never from the stamp.
  const runtimeEnv = await page.locator(".buildstamp .env").textContent();
  expect(["staging", "production"]).toContain(runtimeEnv.trim());
  await expect(page.locator(".buildstamp .env")).toHaveClass(/staging|production/);
});
