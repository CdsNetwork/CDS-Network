/**
 * The package a shipment leg is quoted for: the saved one when the shipment has a weight,
 * otherwise the Shipping settings default. The rates box is prefilled with the same package.
 */
import { describe, expect, it } from "vitest";
import { packageForShipment, packageFormValues, packageFromForm, packageSummary } from "@/lib/shipstation/package";

const DEFAULTS = { default_weight_lb: "45.00", default_length_in: "24.0", default_width_in: "20.0", default_height_in: "20.0" };

describe("packageForShipment", () => {
  it("uses the saved package, without the default box when no size was saved", () => {
    expect(packageForShipment({ weight_lb: "2.00", length_in: null, width_in: null, height_in: null }, DEFAULTS)).toEqual({
      weightLb: 2,
      lengthIn: null,
      widthIn: null,
      heightIn: null,
    });
    expect(packageForShipment({ weight_lb: 2, length_in: 10, width_in: 6, height_in: 4 }, DEFAULTS)).toEqual({
      weightLb: 2,
      lengthIn: 10,
      widthIn: 6,
      heightIn: 4,
    });
  });

  it("uses the default package when the shipment has no weight", () => {
    expect(packageForShipment({ weight_lb: null, length_in: null, width_in: null, height_in: null }, DEFAULTS)).toEqual({
      weightLb: 45,
      lengthIn: 24,
      widthIn: 20,
      heightIn: 20,
    });
    expect(packageForShipment(null, null)).toEqual({ weightLb: 0, lengthIn: null, widthIn: null, heightIn: null });
  });
});

describe("rates box values", () => {
  it("prefills the inputs and reads back the same package", () => {
    const pkg = packageForShipment(null, DEFAULTS);
    const form = packageFormValues(pkg);
    expect(form).toEqual({ weightLb: "45", lengthIn: "24", widthIn: "20", heightIn: "20" });
    expect(packageFromForm(form)).toEqual({ ok: true, pkg });
    expect(packageFormValues({ weightLb: 0, lengthIn: null, widthIn: null, heightIn: null })).toEqual({
      weightLb: "",
      lengthIn: "",
      widthIn: "",
      heightIn: "",
    });
  });

  it("refuses text that is not a number and accepts 150 lb", () => {
    expect(packageFromForm({ weightLb: "abc", lengthIn: "", widthIn: "", heightIn: "" }).ok).toBe(false);
    expect(packageFromForm({ weightLb: "2", lengthIn: "10", widthIn: "x", heightIn: "4" }).ok).toBe(false);
    expect(packageFromForm({ weightLb: "150", lengthIn: "", widthIn: "", heightIn: "" }).ok).toBe(true);
    expect(packageFromForm({ weightLb: " 2.5 ", lengthIn: "", widthIn: "", heightIn: "" })).toEqual({
      ok: true,
      pkg: { weightLb: 2.5, lengthIn: null, widthIn: null, heightIn: null },
    });
  });

  it("summarises the package used for the rates", () => {
    expect(packageSummary({ weightLb: 2, lengthIn: 10, widthIn: 6, heightIn: 4 })).toBe("2 lb, 10 x 6 x 4 in");
    expect(packageSummary({ weightLb: 3, lengthIn: null, widthIn: null, heightIn: null })).toBe("3 lb");
  });
});
