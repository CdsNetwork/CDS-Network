/**
 * "Tomorrow" pickup ETA (Sarah, CDS, 2026-11-17): a shop accepting a pickup job can say it
 * picks the part up tomorrow. pickup_window is a database enum, so the value is added there
 * too (20261119030000_pickup_window_tomorrow.sql); the accept email shows the label.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PICKUP_WINDOWS, pickupWindowLabel } from "@/lib/format";

vi.mock("server-only", () => ({}));
const { acceptedEta } = await import("@/lib/portal-email-store");

describe("Tomorrow pickup window", () => {
  it("is an option with the label Tomorrow", () => {
    expect(PICKUP_WINDOWS).toContainEqual({ value: "tomorrow", label: "Tomorrow" });
    expect(pickupWindowLabel("tomorrow")).toBe("Tomorrow");
  });
  it("is what the accepted email says", () => {
    expect(acceptedEta("tomorrow")).toBe("Tomorrow");
  });
  it("is a value of the pickup_window enum", () => {
    const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261119030000_pickup_window_tomorrow.sql"), "utf8");
    expect(sql).toMatch(/alter type public\.pickup_window add value if not exists 'tomorrow'/);
  });
});
