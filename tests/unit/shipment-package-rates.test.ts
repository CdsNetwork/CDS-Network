/**
 * Clyde (CDS, 2026-11-07): shipping rates were "significantly off" on WO 101861, one NOx sensor
 * from Enviromotive (CO) to First Student Highland (IL). The order page never asked for weight or
 * size, so every quote used the Shipping settings default box (45 lb, 24 x 20 x 20 in, sized for a
 * DPF). Quotes on the same route: 45 lb default about $24 to $47 for UPS Ground; 2 lb small box
 * about $7 to $9, which matches what CDS pays. The rates box on the order now asks for the package
 * weight and size (filled in from the shipment or the default), and Get rates uses and saves them,
 * so the label is bought for the same package.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packageFromForm } from "@/lib/shipstation/package";

const DEFAULTS = { weightLb: 45, lengthIn: 24, widthIn: 20, heightIn: 20 };

describe("packageFromForm", () => {
  it("uses the weight and size the user entered", () => {
    expect(packageFromForm({ weightLb: "2", lengthIn: "10", widthIn: "6", heightIn: "4" })).toEqual({
      ok: true,
      pkg: { weightLb: 2, lengthIn: 10, widthIn: 6, heightIn: 4 },
    });
  });

  it("accepts a weight without a box size", () => {
    expect(packageFromForm({ weightLb: "3", lengthIn: "", widthIn: "", heightIn: "" })).toEqual({
      ok: true,
      pkg: { weightLb: 3, lengthIn: null, widthIn: null, heightIn: null },
    });
  });

  it("refuses a missing, zero or too heavy weight", () => {
    expect(packageFromForm({ weightLb: "", lengthIn: "", widthIn: "", heightIn: "" }).ok).toBe(false);
    expect(packageFromForm({ weightLb: "0", lengthIn: "", widthIn: "", heightIn: "" }).ok).toBe(false);
    expect(packageFromForm({ weightLb: "151", lengthIn: "", widthIn: "", heightIn: "" }).ok).toBe(false);
  });

  it("refuses a partial or invalid box size", () => {
    expect(packageFromForm({ weightLb: "2", lengthIn: "10", widthIn: "", heightIn: "4" }).ok).toBe(false);
    expect(packageFromForm({ weightLb: "2", lengthIn: "10", widthIn: "-6", heightIn: "4" }).ok).toBe(false);
  });

  it("does not silently fall back to the 45 lb default", () => {
    const r = packageFromForm({ weightLb: "2", lengthIn: "", widthIn: "", heightIn: "" });
    expect(r.ok && r.pkg.weightLb).toBe(2);
    expect(r.ok && r.pkg.weightLb).not.toBe(DEFAULTS.weightLb);
  });
});

describe("rates on the order use the package from the rates box", () => {
  const actions = readFileSync("src/app/cds/shipping/label-actions.ts", "utf8");
  const panel = readFileSync("src/components/shipping/LabelPanel.tsx", "utf8");

  it("Get rates takes the package and saves it on the shipment before quoting", () => {
    expect(actions).toMatch(/export async function getShipmentRates\(\s*shipmentId: string,\s*\w+/);
    expect(actions).toMatch(/packageFromForm\(/);
    expect(actions).toMatch(/weight_lb/);
  });

  it("the rates box asks for weight and box size", () => {
    expect(panel).toMatch(/Weight \(lb\)/);
    expect(panel).toMatch(/Length/);
    expect(panel).toMatch(/Width/);
    expect(panel).toMatch(/Height/);
  });
});
