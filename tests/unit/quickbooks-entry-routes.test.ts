/**
 * Intuit's Launch URL and Connect/Reconnect URL: a CDS login goes to the QuickBooks
 * settings or the OAuth start, a signed-out visitor to the login page (coming back after
 * sign-in), a shop login to its own portal.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

let profile: { kind: "cds" | "shop" } | null = null;
vi.mock("@/lib/auth", () => ({ getProfile: async () => profile }));

const launch = (await import("@/app/quickbooks/launch/route")).GET;
const connect = (await import("@/app/quickbooks/connect/route")).GET;

const target = (res: Response) => {
  const url = new URL(res.headers.get("location") ?? "");
  return url.pathname + url.search;
};
const req = (path: string) => new NextRequest(`https://portal.example.com${path}`);

describe("GET /quickbooks/launch", () => {
  it("opens Admin > Settings for a CDS login", async () => {
    profile = { kind: "cds" };
    expect(target(await launch(req("/quickbooks/launch")))).toBe("/cds/admin?tab=settings");
  });

  it("sends a signed-out visitor to sign in, then to Admin > Settings", async () => {
    profile = null;
    expect(target(await launch(req("/quickbooks/launch")))).toBe(`/login?next=${encodeURIComponent("/cds/admin?tab=settings")}`);
  });

  it("sends a shop login to its own portal", async () => {
    profile = { kind: "shop" };
    expect(target(await launch(req("/quickbooks/launch")))).toBe("/shop");
  });
});

describe("GET /quickbooks/connect", () => {
  it("starts the QuickBooks connection for a CDS login", async () => {
    profile = { kind: "cds" };
    expect(target(await connect(req("/quickbooks/connect")))).toBe("/cds/quickbooks/connect");
  });

  it("sends a signed-out visitor to sign in, then back to connect", async () => {
    profile = null;
    expect(target(await connect(req("/quickbooks/connect")))).toBe(`/login?next=${encodeURIComponent("/quickbooks/connect")}`);
  });

  it("sends a shop login to its own portal", async () => {
    profile = { kind: "shop" };
    expect(target(await connect(req("/quickbooks/connect")))).toBe("/shop");
  });
});
