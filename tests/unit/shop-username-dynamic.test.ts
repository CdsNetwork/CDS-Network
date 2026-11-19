/**
 * The Forgot password page reads the shop_username_logins switch, so it must be rendered per
 * request: a page prerendered at build time would keep the switch as it was then.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the Forgot password page is rendered per request", () => {
  const src = readFileSync(new URL("../../src/app/forgot-password/page.tsx", import.meta.url), "utf8");
  expect(src).toMatch(/export const dynamic = "force-dynamic";/);
});
