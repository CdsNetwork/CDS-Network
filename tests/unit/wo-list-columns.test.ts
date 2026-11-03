/**
 * Clyde 2026-11-02: the CDS work order list shows "Date received" right after the WO number
 * (the inbound email's received time for an order from email, else when the order was
 * created) and "Logistics" (local pickup or shipping, from the order's fulfillment).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dateReceived, logisticsLabel } from "@/lib/format";

describe("dateReceived", () => {
  it("uses the email's received time, as a Pacific date", () => {
    expect(dateReceived({ created_at: "2026-11-03T18:00:00Z", work_order_internal: { inbound_emails: { received_at: "2026-11-02T06:30:00Z" } } })).toBe(
      "2026-11-01",
    );
  });

  it("falls back to the order's created date without an email", () => {
    expect(dateReceived({ created_at: "2026-11-03T18:00:00Z", work_order_internal: { inbound_emails: null } })).toBe("2026-11-03");
    expect(dateReceived({ created_at: "2026-11-03T18:00:00Z", work_order_internal: null })).toBe("2026-11-03");
    expect(dateReceived({ created_at: "2026-11-03T18:00:00Z", work_order_internal: [{ inbound_emails: [] }] })).toBe("2026-11-03");
  });
});

describe("logisticsLabel", () => {
  it("names pickup and shipping orders", () => {
    expect(logisticsLabel("pickup")).toBe("Local pickup");
    expect(logisticsLabel("shipping")).toBe("Shipping");
    expect(logisticsLabel("supplier_direct")).toBe("Shipping");
    expect(logisticsLabel("unspecified")).toBe("Not set");
  });
});

describe("CDS work order list", () => {
  const page = readFileSync(new URL("../../src/app/cds/page.tsx", import.meta.url), "utf8");

  it("has Date received right after WO, and a Logistics column", () => {
    expect(page).toMatch(/<th>WO<\/th>\s*<th>Date received<\/th>/);
    expect(page).toMatch(/<th>Logistics<\/th>/);
    expect(page).toMatch(/work_order_internal\(inbound_emails\(received_at\)\)/);
    expect(page).toMatch(/fulfillment/);
    expect(page).toMatch(/colSpan=\{12\}/);
  });
});
