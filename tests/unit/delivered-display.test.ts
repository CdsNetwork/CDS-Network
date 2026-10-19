/**
 * The carrier's delivery date and time is shown (Pacific, through dateTime) on the CDS work
 * order page, for the order and for each leg, and on the shipments list.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("delivered date and time", () => {
  it("the CDS work order page loads and shows it per leg and for the order", () => {
    const wo = source("app/cds/work-orders/[id]/page.tsx");
    expect(wo).toMatch(/"id, direction, carrier, [^"]*delivered_at/);
    expect(wo).toMatch(/s\.delivered_at \? ` • Delivered \$\{dateTime\(s\.delivered_at\)\}`/);
    expect(wo).toMatch(/wo\.delivered_at && `Delivered \$\{dateTime\(wo\.delivered_at\)\}`/);
  });

  it("the shipments list loads and shows it", () => {
    const shipping = source("app/cds/shipping/page.tsx");
    expect(shipping).toMatch(/"id, work_order_id, direction, [^"]*delivered_at/);
    expect(shipping).toMatch(/\{s\.delivered_at && <div className="small">Delivered \{dateTime\(s\.delivered_at\)\}<\/div>\}/);
  });
});
