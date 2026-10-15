import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("BUG-5: sign-in links only redirect inside the portal", () => {
  it.each([
    ["/account/password", "/account/password"],
    ["/cds/work-orders/1?x=1", "/cds/work-orders/1?x=1"],
    ["/\\evil.example/", "/account/password"],
    ["//evil.example", "/account/password"],
    ["https://evil.example", "/account/password"],
    ["/%5Cevil.example", "/account/password"],
    ["\\\\evil.example", "/account/password"],
    [null, "/account/password"],
    ["", "/account/password"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});
