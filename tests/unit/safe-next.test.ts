import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

const FALLBACK = "/account/password";

describe("BUG-5: sign-in links only redirect inside the portal", () => {
  it.each([
    ["/account/password", "/account/password"],
    ["/cds/work-orders/1?x=1", "/cds/work-orders/1?x=1"],
    ["/\\evil.example/", FALLBACK],
    ["//evil.example", FALLBACK],
    ["https://evil.example", FALLBACK],
    ["/%5Cevil.example", FALLBACK],
    ["\\\\evil.example", FALLBACK],
    [null, FALLBACK],
    ["", FALLBACK],
  ])("%s -> %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

describe("BUG-M2-15: no open redirect through next", () => {
  it.each([
    // Paths on this site, kept as given (pathname + search + hash).
    ["/", "/"],
    ["/cds/admin?tab=settings", "/cds/admin?tab=settings"],
    ["/quickbooks/connect", "/quickbooks/connect"],
    ["/cds/work-orders/1#lines", "/cds/work-orders/1#lines"],
    ["/shop?q=a%20b", "/shop?q=a%20b"],
    ["/cds/./admin", "/cds/admin"],
    ["/cds/../shop", "/shop"],
    ["/a/b/../../cds", "/cds"],
    ["/%7Euser", "/%7Euser"],
    ["/cds?next=//evil.example", "/cds?next=//evil.example"],
  ])("allowed %s -> %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  const attacks: string[] = [
    // Dot segments that normalise to a protocol relative path (the reported bug).
    "/.//evil.example",
    "/..//evil.example",
    "/./..//evil.example",
    "/../..//evil.example",
    "/a/..//evil.example",
    "/.///evil.example",
    "/x/../..//evil.example/path?q=1",
    // Encoded dots and slashes.
    "/%2e%2e//evil.example",
    "/%2E%2E//evil.example",
    "/%2e//evil.example",
    "/%2E%2E%2F/evil.example",
    "/%2e%2e%2f%2fevil.example",
    "/.%2e//evil.example",
    "/%2e.//evil.example",
    "%2F%2Fevil.example",
    "/%2F/evil.example",
    "/%2F%2Fevil.example",
    // Double and triple encoding.
    "/%252e%252e//evil.example",
    "/%252F%252Fevil.example",
    "%252F%252Fevil.example",
    "/%25252e%25252e//evil.example",
    "/%255Cevil.example",
    "/%25255Cevil.example",
    // Backslashes, raw and encoded, anywhere.
    "/\\evil.example",
    "\\/evil.example",
    "/.\\/evil.example",
    "/..\\/evil.example",
    "/cds\\..\\..\\/evil.example",
    "/%5C/evil.example",
    "/%5c%5cevil.example",
    "/cds/%5C",
    // Tabs, newlines and other control characters.
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/%09/evil.example",
    "/%0a/evil.example",
    "/%0D%0A/evil.example",
    "/%00/evil.example",
    "/.%09//evil.example",
    "/\u007f/evil.example",
    // Schemes in any case, with or without a leading slash.
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "/javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "http:/evil.example",
    "http:evil.example",
    "HTTPS://evil.example",
    "https:\\\\evil.example",
    "%6Aavascript:alert(1)",
    "/%2F%2Fevil.example%2F",
    // Protocol relative and userinfo tricks.
    "//evil.example",
    "///evil.example",
    "////evil.example",
    "//portal.invalid@evil.example",
    "/@evil.example",
    "@evil.example",
    "//@evil.example",
    "/%2F@evil.example",
    "evil.example",
    "cds/admin",
    "./cds",
    "../cds",
    "?next=x",
    "#x",
    // Unicode look alikes and spaces.
    "/　/evil.example",
    "/ /evil.example",
    "/／/evil.example",
    " /cds",
    "/cds ",
    // Malformed encoding.
    "/%",
    "/%zz",
    "/%E0%A4%A",
  ];
  it.each(attacks)("refused %j", (input) => {
    expect(safeNext(input)).toBe(FALLBACK);
  });

  it("refuses very long input", () => {
    expect(safeNext("/" + "a".repeat(5000))).toBe(FALLBACK);
    expect(safeNext("/" + "%25".repeat(2000) + "2F%2Fevil.example")).toBe(FALLBACK);
  });

  it("uses the caller's fallback", () => {
    expect(safeNext("/.//evil.example", "/")).toBe("/");
  });

  it("never returns something that leaves the site when resolved against any origin", () => {
    for (const input of attacks) {
      const out = safeNext(input, "/");
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "https://portal.example").origin).toBe("https://portal.example");
    }
  });
});
