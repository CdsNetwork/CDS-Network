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
    expect(page).toMatch(/work_order_internal\(inbound_emails\(received_at\), internal_status, qb_invoice_number, qb_invoice_id\)/);
    expect(page).toMatch(/fulfillment/);
    expect(page).toMatch(/colSpan=\{12\}/);
  });

  it("shows CDS's internal status in the Status column, with no new column (2026-11-12), editable there (M3)", () => {
    expect(page).toMatch(/<ListInternalStatusSelect[\s\S]*?value=\{internal\?\.internal_status \?\? null\}/);
    expect(page).toMatch(/className="badge internal"/);
  });

  it("marks an order invoiced in QuickBooks while the shop is still working (2026-11-12)", () => {
    expect(page).toMatch(/qb_invoice_number, qb_invoice_id\)/);
    expect(page).toMatch(/invoicedEarly/);
    expect(page).toMatch(/Invoiced \{/);
  });

  it("keeps every row control on the shorter rows: status pill and both selects on one line, WO link with Notes (2026-11-18)", () => {
    const edits = readFileSync(new URL("../../src/components/cds-wo/ListRowEdits.tsx", import.meta.url), "utf8");
    expect(page).toMatch(
      /<div className=\{styles\.statusLine\}>\s*<span className=\{`status \$\{r\.status\}`\}>[\s\S]*?<ListStatusSelect woId=\{r\.id\} moves=\{moves\} \/>\s*<ListInternalStatusSelect[\s\S]*?<\/div>/,
    );
    expect(edits).toMatch(/aria-label="Change status"/);
    expect(edits).toMatch(/aria-label="Internal status \(CDS only\)"/);
    expect(edits).toMatch(/<option value="">No internal status<\/option>/);
    expect(page).toMatch(/<div className=\{styles\.woLine\}>\s*<Link[\s\S]*?<\/Link>\s*<ListNotesButton /);
    expect(page).toMatch(/Question Pending/);
    expect(page).toMatch(/New from shop/);
    expect(page).toMatch(/Correction requested/);
  });
});
