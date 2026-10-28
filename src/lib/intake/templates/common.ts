/**
 * Shared pieces of the request template parsers: the result shape and a reader for the
 * "Label: value" (or label TAB value, for HTML tables) layout all three templates use.
 */
import type { Component, Fulfillment, TemplateName } from "../types";

export type TemplateItem = {
  description: string;
  /** A CDS SKU or customer item number written on the request. */
  partNumber: string | null;
  /** The CDS service this line names (Ryder service list), matched by SKU first. */
  sku?: string | null;
  qty: number;
  component: Component | null;
  /** A cleaning (service) rather than a part. */
  service: boolean;
  price?: number | null;
  requiredDate?: string | null;
  taxable?: boolean | null;
  costCenter?: string | null;
  returnToLocation?: boolean;
  /** "DPF Clamps and Gaskets": the kit depends on the unit, so it is matched by Part # only. */
  kit?: boolean;
};

export type TemplateText =
  | "location_number"
  | "location_name"
  | "location_address"
  | "location_suffix"
  | "unit_number"
  | "po_number"
  | "vin"
  | "requested_date"
  | "order_type"
  | "region"
  | "serial_number"
  | "manufacturer"
  | "part_number"
  | "comments"
  | "contact_name"
  | "contact_email"
  | "contact_phone"
  | "store_room"
  | "pickup_option"
  | "filter_options"
  | "parts_or_service"
  | "cost_center"
  | "order_description"
  | "pickup_address";

export type TemplateResult = {
  template: TemplateName;
  /** Who the template belongs to: matched to a customer by code or name. */
  customer: { codes: string[]; names: string[]; label: string };
  fields: Partial<Record<TemplateText, string>> & {
    mileage?: number;
    return_to_location?: boolean;
    fulfillment?: Fulfillment;
  };
  items: TemplateItem[];
  warnings: string[];
};

const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads "Label: value" lines. A label is matched at the start of a line, followed by a colon,
 * a tab (HTML table cells), two spaces or the end of the line. An empty value is null. Labels
 * listed in `multiline` also take the following lines up to a blank line or another label.
 *
 * Options for a table of several label and value cells per row:
 *  * `inline`: these labels are also found later in a line that starts with a label, after
 *    whitespace, with a single space before the value and written exactly (case included).
 *    A row arrives as one line of text ("Unit #  284113  Manufacturer  Cummins", tabs
 *    expanded to spaces). Each label is read once, at its first place, so the same word
 *    later in a value ("Region  North Region") stays in the value.
 *  * `stacked`: a label alone on its line takes the next line with text as its value, unless
 *    that line starts with a label (each cell on its own line, as some mail apps quote it,
 *    Outlook with a blank line between a label and its value).
 */
export function readLabels<L extends string>(
  text: string,
  labels: readonly L[],
  multiline: readonly L[] = [],
  options: { inline?: readonly L[]; stacked?: boolean } = {},
): Record<L, string | null> {
  const inline = options.inline ?? [];
  const lines = text.split("\n").map((l) => l.replace(/ /g, " ").trim());
  // Longest first, so "Ship to City, State, ZIP" wins over a shorter label at the same start.
  const ordered = [...labels].sort((a, b) => b.length - a.length);
  const res = ordered.map((label) => ({ label, re: new RegExp(String.raw`^${escape(label)}\s*(?::|\t|\s{2,}|$)\s*(.*)$`, "i") }));
  const labelAt = (line: string) => res.find(({ re }) => re.test(line));
  const inlineRes = ordered
    .filter((l) => inline.includes(l))
    .map((label) => ({ label, re: new RegExp(String.raw`(?<=^|\s)${escape(label)}(?=\s|:|$)`, "g") }));
  const out = Object.fromEntries(labels.map((l) => [l, null])) as Record<L, string | null>;
  const seen = new Set<L>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hit = labelAt(line);
    // Where each label of the line starts and ends, in order: the next label ends a value.
    const cells: { label: L; start: number; end: number }[] = [];
    // A label at the start of the line is read while it has no value yet, as before.
    if (hit && out[hit.label] === null) cells.push({ label: hit.label, start: 0, end: line.length - line.match(hit.re)![1].length });
    if (hit) seen.add(hit.label);
    const later = inlineRes
      .flatMap(({ label, re }) => [...line.matchAll(re)].map((m) => ({ label, start: m.index, end: m.index + label.length })))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    // Only a row (a line that starts with a label) holds more labels: "the PO # to ..." in a
    // sentence is not one.
    const row = !!hit || later.some((h) => h.start === 0);
    for (const h of row ? later : []) {
      const last = cells[cells.length - 1];
      if ((last && h.start < last.end) || seen.has(h.label) || cells.some((c) => c.label === h.label)) continue;
      cells.push(h);
    }
    for (let k = 0; k < cells.length; k++) {
      const { label, start, end } = cells[k];
      seen.add(label);
      let value = clean(line.slice(end, cells[k + 1]?.start ?? line.length).replace(/^\s*:?\s*/, ""));
      const alone = start === 0 && cells.length === 1;
      const startsWithLabel = (l: string) => !!labelAt(l) || inlineRes.some(({ re }) => new RegExp(`^${re.source}`).test(l));
      if (alone && multiline.includes(label)) {
        const more: string[] = value ? [value] : [];
        for (let j = i + 1; j < lines.length && lines[j] && !startsWithLabel(lines[j]); j++) more.push(clean(lines[j]));
        value = more.filter(Boolean).join("\n");
      } else if (alone && !value && options.stacked) {
        // The next line with text, past the blank lines a quoted form may put after a label.
        let j = i + 1;
        while (j < lines.length && !lines[j]) j++;
        if (j < lines.length && !startsWithLabel(lines[j])) value = clean(lines[j]);
      }
      out[label] = value || null;
    }
  }
  return out;
}

/** How many of the labels start a line (with or without a value): marks a template's body. */
export function countLabels(text: string, labels: readonly string[]): number {
  return labels.filter((l) => new RegExp(String.raw`^[ \t]*${escape(l)}[ \t]*(?::|\t|[ ]{2,}|$)`, "im").test(text)).length;
}

function clean(v: string): string {
  return v.replace(/\t+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** "10/21/2026" or "2026-10-21" as an ISO date, or null when it is not a real date. */
export function isoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  let y: number, m: number, d: number;
  const us = v.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const iso = v.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (us) [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "412,550" or "412550 mi" as a whole number of miles, or null. */
export function miles(v: string | null | undefined): number | null {
  const digits = v?.match(/\d[\d,]*/)?.[0]?.replace(/,/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n >= 0 && n < 10_000_000 ? n : null;
}

/** A decimal amount ("$1,325.00"), or null. */
export function amount(v: string | null | undefined): number | null {
  const m = v?.match(/-?\d[\d,]*(?:\.\d+)?/)?.[0]?.replace(/,/g, "");
  if (!m) return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

/** Components named in a short value such as "DPF, DOC" or "DPF/DOC". */
export function componentsIn(v: string | null | undefined): Component[] {
  if (!v) return [];
  const out: Component[] = [];
  for (const c of ["DPF", "DOC", "SCR", "EGR"] as const) if (new RegExp(String.raw`\b${c}\b`, "i").test(v)) out.push(c);
  return out;
}

/** Drops empty values so the result only names what the email gave. */
export function present<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as { [K in keyof T]?: NonNullable<T[K]> };
}
