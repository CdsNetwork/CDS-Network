import { describe, expect, it } from "vitest";
import { initials, isCollapsed, SIDEBAR_COOKIE, sidebarCookie } from "@/lib/sidebar";

// The office sidebar remembers whether it is collapsed in a cookie, read by the server layout
// so the first paint already has the right width.
describe("sidebar cookie", () => {
  it("is expanded unless the cookie says collapsed", () => {
    expect(isCollapsed(undefined)).toBe(false);
    expect(isCollapsed(null)).toBe(false);
    expect(isCollapsed("")).toBe(false);
    expect(isCollapsed("0")).toBe(false);
    expect(isCollapsed("yes")).toBe(false);
    expect(isCollapsed("1")).toBe(true);
  });

  it("round-trips the value written in the browser through isCollapsed", () => {
    for (const collapsed of [true, false]) {
      const cookie = sidebarCookie(collapsed);
      expect(cookie.startsWith(`${SIDEBAR_COOKIE}=`)).toBe(true);
      const value = cookie.split(";")[0].slice(SIDEBAR_COOKIE.length + 1);
      expect(isCollapsed(value)).toBe(collapsed);
    }
  });

  it("applies to the whole site and lasts a year", () => {
    const cookie = sidebarCookie(true);
    expect(cookie).toMatch(/; path=\/;/);
    expect(cookie).toMatch(/max-age=31536000/);
    expect(cookie).toMatch(/samesite=lax/i);
  });
});

describe("initials", () => {
  it("takes the first letter of the first and last word", () => {
    expect(initials("Ashley Schmidt")).toBe("AS");
    expect(initials("mary ann smith")).toBe("MS");
  });

  it("uses one letter for a single name and ? for no name", () => {
    expect(initials("  Clyde  ")).toBe("C");
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
    expect(initials(null)).toBe("?");
    expect(initials(undefined)).toBe("?");
  });
});
