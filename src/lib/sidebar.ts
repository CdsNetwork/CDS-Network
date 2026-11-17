// The office sidebar's collapsed choice lives in a cookie so the server layout renders the right
// width on the first paint (no flash). Anything but "1" means expanded, the default.
export const SIDEBAR_COOKIE = "portal_sidebar_collapsed";
const ONE_YEAR = 60 * 60 * 24 * 365;

export function isCollapsed(value: string | undefined | null): boolean {
  return value === "1";
}

export function sidebarCookie(collapsed: boolean): string {
  return `${SIDEBAR_COOKIE}=${collapsed ? "1" : "0"}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

// Up to two letters: first and last word of the name, so "Mary Ann Smith" is "MS".
export function initials(fullName: string | null | undefined): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}
