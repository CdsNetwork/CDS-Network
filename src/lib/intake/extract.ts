/**
 * Stage 1: deterministic extraction. Regular expressions for the fields fleets label the
 * same way every time (PO, unit, location number, VIN), the pickup or shipping hint, and a
 * first guess at whether the email is a work request at all.
 */
import type { Component, Fulfillment } from "./types";

export type Deterministic = {
  poNumber: string | null;
  unitNumber: string | null;
  locationNumbers: string[];
  vin: string | null;
  vinValid: boolean;
  fulfillment: Fulfillment;
  fulfillmentConflict: boolean;
  components: Component[];
  zip: string | null;
  workSignals: number;
  nonWorkReason: string | null;
};

// The value must hold a digit; the lookahead lets the scan move on past "Vehicle Bus 7720".
const VALUE = String.raw`((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{0,24}[A-Z0-9]|[0-9])`;
const LABEL_TAIL = String.raw`\s*(?:#|no\.?|nbr\.?|number|num\.?|code)?\s*[:#\-]?\s*`;

const PO_RE = new RegExp(String.raw`(?:\bP\.\s?O\.?|\bPO\b|\bpurchase\s+order\b)` + LABEL_TAIL + VALUE, "gi");
const UNIT_RE = new RegExp(String.raw`\b(?:unit|truck|tractor|trailer|bus|vehicle|asset)\b` + LABEL_TAIL + VALUE, "gi");
const LOCATION_RE = new RegExp(
  String.raw`\b(?:location|loc|branch|dept|department|facility|site|shop)\b\.?` + LABEL_TAIL + VALUE,
  "gi",
);
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const ZIP_RE = /\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/;

const hasDigit = (v: string) => /\d/.test(v);

function firstValue(re: RegExp, text: string, reject?: (value: string, after: string) => boolean): string | null {
  return allValues(re, text, reject)[0] ?? null;
}

function allValues(re: RegExp, text: string, reject?: (value: string, after: string) => boolean): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const value = m[1].toUpperCase().replace(/[\-\/]+$/, "");
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 20);
    if (!hasDigit(value) || reject?.(value, after)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

const VIN_MAP: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** North American VIN check digit (position 9). */
export function vinCheckDigitOk(vin: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    sum += (/\d/.test(c) ? Number(c) : VIN_MAP[c]) * VIN_WEIGHTS[i];
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? "X" : String(r));
}

const PICKUP_RE = /\bpick\s?-?\s?up\b|\bpicked up\b|\bcome (?:get|grab)\b|\bready for (?:pick\s?up|collection)\b/gi;
// "Ship To" is an address label, not a request to ship.
const SHIP_RE = /\bship(?:ping)?\b(?!\s*to\b)|\bshipping label\b|\bfed\s?ex\b|\bUPS\b|\bsend (?:us )?(?:a )?(?:label|box)\b|\bwe have a box\b/gi;

function count(re: RegExp, text: string): number {
  return [...text.matchAll(re)].length;
}

const WORK_WORDS =
  /\b(DPF|DOC|SCR|EGR|diesel particulate|clean(?:ing|ed)?|bake|filter|work order|service request|pick\s?-?\s?up|unit|truck|bus|gasket|clamp)\b/gi;
const NON_WORK: [RegExp, string][] = [
  [/\bremittance\b|\bpayment (?:advice|number|has been issued)\b/i, "Payment or remittance notice"],
  [/\bstatement of account\b|\baccount statement\b/i, "Account statement"],
  [/\bout of (?:the )?office\b|\bautomatic reply\b|\bauto-?reply\b/i, "Automatic reply"],
  [/\bunsubscribe\b|\bnewsletter\b/i, "Newsletter or marketing"],
  [/\bundeliverable\b|\bdelivery status notification\b|\bmail delivery (?:failed|subsystem)\b/i, "Bounce message"],
];

const COMPONENTS: [RegExp, Component][] = [
  [/\bDPF\b|\bdiesel particulate\b/i, "DPF"],
  [/\bDOC\b|\bdiesel oxidation\b/i, "DOC"],
  [/\bSCR\b/i, "SCR"],
  [/\bEGR\b/i, "EGR"],
];

const COMPONENT_WORDS: [string, Component][] = [
  [String.raw`DPF|diesel particulate(?: filters?)?`, "DPF"],
  [String.raw`DOC|diesel oxidation(?: catalysts?)?`, "DOC"],
  [String.raw`SCR`, "SCR"],
  [String.raw`EGR(?: cooler)?`, "EGR"],
];
// "Clean Diesel" is CDS's own name, not a request.
const CLEAN_WORDS = String.raw`clean(?:ing|ed)?(?!\W+diesel\b)|bake|baked|flush(?:ed)?|service`;

const ANY_COMPONENT = COMPONENT_WORDS.map(([re]) => `(?:${re})`).join("|");
// A list of components: "DPF", "DPF and DOC", "DPF, DOC, and SCR", "DPF/DOC/SCR", "DPF & the DOC",
// "DPF and also the DOC", "DPF plus the DOC".
const LIST_FILLER = String.raw`(?:(?:also|then|the)\s+){0,2}`;
const COMPONENT_LIST = String.raw`\b(?:${ANY_COMPONENT})\b(?:\s*(?:,\s*(?:and\s+)?|\/|&|\+|\band\b|\bplus\b)\s*${LIST_FILLER}\b(?:${ANY_COMPONENT})\b)*`;
const NEGATION = /\b(?:no|not|without|never|skip)\b|n't\b/i;
const NEGATED_BEFORE = /(?:\b(?:no|not|without|never|skip)|n't)\W+(?:(?:need|needs|want|any|the|a)\W+){0,2}$/i;
// Parts named next to a component ("DOC clamp", "DPF inlet gasket"): not a cleaning request.
const PART_WORDS = /\b(?:gaskets?|clamps?|sensors?|bolts?|nuts?|hardware|kits?|seals?|bands?|pipes?|hoses?|brackets?|studs?)\b/i;
const CLEANING_REQUESTS = [
  // "clean the DPF and DOC", "Clean DPF, DOC and SCR"
  new RegExp(String.raw`\b(?:${CLEAN_WORDS})\W+(?:\w+\W+){0,2}?(${COMPONENT_LIST})`, "gi"),
  // "DPF and DOC cleaning", "DPF/DOC/SCR cleaning", "EGR cooler cleaning"
  new RegExp(String.raw`(${COMPONENT_LIST})\W+(?:\w+\W+){0,2}?(?:${CLEAN_WORDS})\b`, "gi"),
];

/**
 * Components the text asks to have cleaned: a component, or a list of components, and a
 * cleaning word at most two words apart ("DPF clean", "clean the DPF", "Clean DPF, DOC and
 * SCR", "DPF and DOC cleaning"). A component named only in a part description ("DPF inlet
 * gasket", "DOC clamp, cleaning not needed") or a declined cleaning ("no DOC cleaning", "DOC
 * clamp, no cleaning") is not a cleaning request.
 */
export function requestedCleanings(text: string): Component[] {
  const lists = CLEANING_REQUESTS.flatMap((re) =>
    [...text.matchAll(re)]
      .filter((m) => {
        // The words between the cleaning word and the components: a declined cleaning
        // ("DOC clamp, no cleaning") or a part ("DOC clamp ... cleaning") is not a request.
        const between = m[0].replace(m[1], " ");
        if (NEGATION.test(between) || PART_WORDS.test(between)) return false;
        // "no DPF cleaning", "do not clean the DOC", "don't need DOC cleaning".
        return !NEGATED_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index));
      })
      .map((m) => m[1]),
  );
  return COMPONENT_WORDS.filter(([re]) => lists.some((list) => new RegExp(String.raw`\b(?:${re})\b`, "i").test(list))).map(([, c]) => c);
}

export function extractDeterministic(subject: string, text: string): Deterministic {
  const all = `${subject}\n${text}`;
  const poNumber = firstValue(PO_RE, all, (_v, after) => /^\s*box\b/i.test(after));
  const unitNumber = firstValue(UNIT_RE, all);
  const locationNumbers = allValues(LOCATION_RE, all);

  let vin: string | null = null;
  let vinValid = false;
  for (const m of all.toUpperCase().matchAll(VIN_RE)) {
    if (!/[A-Z]/.test(m[0]) || !/\d/.test(m[0])) continue;
    const ok = vinCheckDigitOk(m[0]);
    if (!vin || (ok && !vinValid)) {
      vin = m[0];
      vinValid = ok;
    }
  }

  const pickups = count(PICKUP_RE, all);
  const ships = count(SHIP_RE, all);
  const fulfillment: Fulfillment = pickups > ships ? "pickup" : ships > pickups ? "shipping" : "unspecified";

  const components = COMPONENTS.filter(([re]) => re.test(all)).map(([, c]) => c);
  const workSignals = count(WORK_WORDS, all);
  const nonWork = NON_WORK.find(([re]) => re.test(all));

  return {
    poNumber,
    unitNumber,
    locationNumbers,
    vin,
    vinValid,
    fulfillment,
    fulfillmentConflict: pickups > 0 && ships > 0,
    components,
    zip: all.match(ZIP_RE)?.[1] ?? null,
    workSignals,
    // A payment notice that happens to say "unit" once is still not a work request.
    nonWorkReason: nonWork && workSignals < 3 ? nonWork[1] : workSignals === 0 ? "No work request found" : null,
  };
}

/** Part numbers written in the email that equal a known part number (customer's or ours). */
export function findKnownPartNumbers(text: string, known: string[]): { partNumber: string; qty: number }[] {
  const out: { partNumber: string; qty: number }[] = [];
  const lines = text.split(/\n/);
  for (const pn of known) {
    if (!pn || pn.length < 3) continue;
    const escaped = pn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(String.raw`(?<![A-Z0-9-])${escaped}(?![A-Z0-9-])`, "i");
    const line = lines.find((l) => re.test(l));
    if (!line) continue;
    out.push({ partNumber: pn, qty: quantityOnLine(line, pn) });
  }
  return out;
}

/** The quantity written next to a part number: "Qty 2", "x2", "(2)", "2 ea", or a last-column number. */
export function quantityOnLine(line: string, partNumber: string): number {
  const rest = line.replace(new RegExp(partNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  const explicit =
    rest.match(/\bqty\.?\s*[:#]?\s*(\d{1,3})\b/i) ??
    rest.match(/(?:^|\s)x\s?(\d{1,3})\b/i) ??
    rest.match(/\((\d{1,3})\)/) ??
    rest.match(/\b(\d{1,3})\s*(?:ea|each|pcs?)\b/i) ??
    rest.match(/(?:\t|\s{2,})(\d{1,3})\s*$/);
  const n = explicit ? Number(explicit[1]) : 1;
  return n > 0 && n < 1000 ? n : 1;
}
