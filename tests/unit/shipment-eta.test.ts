/**
 * QA m2-r9 cosmetic: after a label was voided the CDS pages still showed the voided label's ETA
 * next to "Needs Label". The ETA belongs to the label, so it is hidden until a new label exists.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shipmentEta } from "@/lib/format";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("shipmentEta", () => {
  it("shows the ETA of a leg on its way", () => {
    expect(shipmentEta({ eta_text: "3 business days", status: "in_transit", label_status: "ready" })).toBe("3 business days");
    expect(shipmentEta({ eta_text: "Oct 24, 2026", status: "label_created", label_status: "ready" })).toBe("Oct 24, 2026");
  });

  it("hides it after a void put the leg back to Needs Label", () => {
    expect(shipmentEta({ eta_text: "3 business days", status: "label_needed", label_status: "voided" })).toBeNull();
  });

  it("keeps a leg the carrier already scanned before the void", () => {
    expect(shipmentEta({ eta_text: "Oct 24, 2026", status: "in_transit", label_status: "voided" })).toBe("Oct 24, 2026");
  });

  it("hides it once delivered or when there is none", () => {
    expect(shipmentEta({ eta_text: "Oct 24, 2026", status: "delivered", label_status: "ready" })).toBeNull();
    expect(shipmentEta({ eta_text: null, status: "in_transit", label_status: "ready" })).toBeNull();
    expect(shipmentEta({ eta_text: "  ", status: "in_transit", label_status: "ready" })).toBeNull();
  });

  it("is used by the CDS work order page and the shipments list", () => {
    expect(source("app/cds/work-orders/[id]/page.tsx")).toMatch(/shipmentEta\(s\)/);
    expect(source("app/cds/shipping/page.tsx")).toMatch(/shipmentEta\(s\)/);
  });
});
