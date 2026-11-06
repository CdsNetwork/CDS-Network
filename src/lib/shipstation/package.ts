/**
 * The package (weight and box size) a shipment leg is quoted and labelled for. Pure functions:
 * no network, no database, safe to import from client components.
 */
import { MAX_PARCEL_LB } from "./requests";

export type ShipmentPackage = {
  weightLb: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
};

export type PackageForm = { weightLb: string; lengthIn: string; widthIn: string; heightIn: string };

export type PackageFormResult = { ok: true; pkg: ShipmentPackage } | { ok: false; error: string };

type Value = number | string | null | undefined;

const toNumber = (v: Value): number | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Validates the weight and box size typed in the rates box. Weight is required, above 0 and at
 * most MAX_PARCEL_LB. Box size is all three sides or none. Never fills in a default.
 */
export function packageFromForm(input: PackageForm): PackageFormResult {
  const raw = String(input?.weightLb ?? "").trim();
  if (raw === "") return { ok: false, error: "Enter the package weight in lb." };
  const weightLb = toNumber(raw);
  if (weightLb === null || weightLb <= 0) return { ok: false, error: "Weight must be a number above 0." };
  if (weightLb > MAX_PARCEL_LB) return { ok: false, error: `Parcel labels are limited to ${MAX_PARCEL_LB} lb; ship heavier parts as freight.` };

  const sides = [input?.lengthIn, input?.widthIn, input?.heightIn].map((v) => String(v ?? "").trim());
  if (sides.every((s) => s === "")) return { ok: true, pkg: { weightLb, lengthIn: null, widthIn: null, heightIn: null } };
  if (sides.some((s) => s === "")) return { ok: false, error: "Enter length, width and height, or leave all three empty." };
  const [lengthIn, widthIn, heightIn] = sides.map(toNumber);
  if ([lengthIn, widthIn, heightIn].some((n) => n === null || n <= 0)) {
    return { ok: false, error: "Length, width and height must be numbers above 0." };
  }
  return { ok: true, pkg: { weightLb, lengthIn, widthIn, heightIn } };
}

export type SavedPackage = { weight_lb: Value; length_in: Value; width_in: Value; height_in: Value };
export type DefaultPackage = {
  default_weight_lb: Value;
  default_length_in: Value;
  default_width_in: Value;
  default_height_in: Value;
};

/**
 * The package a shipment is quoted for: the one saved on the shipment when it has a weight
 * (its box size as saved, none when empty), otherwise the Shipping settings default package.
 * Used both to prefill the rates box and by the rates and label requests, so they match.
 */
export function packageForShipment(saved: SavedPackage | null | undefined, defaults: DefaultPackage | null | undefined): ShipmentPackage {
  const weight = toNumber(saved?.weight_lb);
  if (weight !== null) {
    return { weightLb: weight, lengthIn: toNumber(saved?.length_in), widthIn: toNumber(saved?.width_in), heightIn: toNumber(saved?.height_in) };
  }
  return {
    weightLb: toNumber(defaults?.default_weight_lb) ?? 0,
    lengthIn: toNumber(defaults?.default_length_in),
    widthIn: toNumber(defaults?.default_width_in),
    heightIn: toNumber(defaults?.default_height_in),
  };
}

/** The rates box inputs for a package (empty text for a missing value). */
export function packageFormValues(pkg: ShipmentPackage): PackageForm {
  const s = (n: number | null) => (n === null || !Number.isFinite(n) || n <= 0 ? "" : String(n));
  return { weightLb: s(pkg.weightLb), lengthIn: s(pkg.lengthIn), widthIn: s(pkg.widthIn), heightIn: s(pkg.heightIn) };
}

/** "2 lb, 10 x 6 x 4 in" (or "2 lb" without a box size). */
export function packageSummary(pkg: Pick<ShipmentPackage, "weightLb"> & Partial<ShipmentPackage>): string {
  const sides = [pkg.lengthIn, pkg.widthIn, pkg.heightIn];
  const box = sides.every((n) => typeof n === "number" && n > 0) ? `, ${sides.join(" x ")} in` : "";
  return `${pkg.weightLb} lb${box}`;
}
