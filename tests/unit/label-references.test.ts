/**
 * Shipping label references (Sarah, CDS, 2026-11-17): the customer's PO is printed as the
 * first reference when the order has one, with "WO <n>" as the second; an optional Reference
 * typed on the CDS create-label form goes in the next free reference. Carriers print up to 35
 * characters per reference.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLabelRequest, labelReferences } from "@/lib/shipstation/requests";

describe("labelReferences", () => {
  it("is WO <n> alone when there is no PO and no extra reference", () => {
    expect(labelReferences({ woNumber: 104100, po: null })).toEqual({ reference1: "WO 104100" });
    expect(labelReferences({ woNumber: 104100, po: "   ", extra: "" })).toEqual({ reference1: "WO 104100" });
  });
  it("puts the PO first and the WO second", () => {
    expect(labelReferences({ woNumber: 104100, po: " 4500123 " })).toEqual({ reference1: "4500123", reference2: "WO 104100" });
  });
  it("puts the extra reference third with a PO, second without", () => {
    expect(labelReferences({ woNumber: 1, po: "PO9", extra: "Unit 1558" })).toEqual({ reference1: "PO9", reference2: "WO 1", reference3: "Unit 1558" });
    expect(labelReferences({ woNumber: 1, po: null, extra: "Unit 1558" })).toEqual({ reference1: "WO 1", reference2: "Unit 1558" });
  });
  it("cuts every reference to 35 characters", () => {
    const r = labelReferences({ woNumber: 1, po: "P".repeat(60), extra: "E".repeat(60) });
    for (const v of Object.values(r)) expect(v.length).toBeLessThanOrEqual(35);
    expect(r.reference1).toBe("P".repeat(35));
  });
});

describe("buildLabelRequest with references", () => {
  it("sends all references as label_messages", () => {
    const addr = { name: "A", phone: "1", address_line1: "1 St", city_locality: "X", state_province: "AZ", postal_code: "85001", country_code: "US", address_residential_indicator: "no" as const };
    const body = buildLabelRequest({
      shipFrom: addr,
      shipTo: addr,
      pkg: { weightLb: 3 },
      carrierId: "se-1",
      serviceCode: "ups_ground",
      testLabel: true,
      references: { reference1: "PO9", reference2: "WO 1", reference3: "Unit 1558" },
      externalShipmentId: "x",
    });
    expect(body.shipment.packages[0].label_messages).toEqual({ reference1: "PO9", reference2: "WO 1", reference3: "Unit 1558" });
  });
});

describe("label creation", () => {
  const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
  it("loads the order's PO and uses labelReferences", () => {
    const labels = src("lib/shipstation/labels.ts");
    expect(labels).toMatch(/work_orders\(id, wo_number, po_number/);
    expect(labels).toMatch(/labelReferences\(\{ woNumber: ctx\.woNumber, po: ctx\.poNumber, extra: choice\.reference/);
  });
  it("the CDS create-label form has an optional Reference field sent with the choice", () => {
    const panel = src("components/shipping/LabelPanel.tsx");
    expect(panel).toMatch(/Reference \(optional\)/);
    expect(panel).toMatch(/maxLength=\{35\}/);
    expect(panel).toMatch(/reference: reference/);
    expect(src("app/cds/shipping/label-actions.ts")).toMatch(/reference:/);
  });
});
