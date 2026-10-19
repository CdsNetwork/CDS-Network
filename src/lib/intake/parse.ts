/**
 * The intake pipeline for one email: deterministic extraction, then the AI stage for the
 * rest (when configured), then matching to customers, locations and catalog items in code.
 * Pure apart from the reference data and the AI call, both passed in.
 */
import { bodyText, emailAddress, quotedSenders } from "./email";
import { extractDeterministic, findKnownPartNumbers, requestedCleanings } from "./extract";
import type { LlmExtraction, LlmExtractor } from "./llm";
import { matchCustomer, matchItem, matchLocation, partKey, type ItemInput } from "./match";
import { matchableCatalog, type Component, type Field, type Fulfillment, type IntakeReference, type ItemMatch, type LocationRef, type NormalizedEmail, type ParsedEmail } from "./types";

/** Without the AI stage a draft is never better than low confidence. */
export const DETERMINISTIC_ONLY_CAP = 0.45;

const none = <T>(): Field<T> => ({ value: null, source: "none", confidence: 0 });

function pick(regex: string | null, llm: string | null, regexConfidence = 0.9): Field<string> {
  if (regex) return { value: regex, source: "regex", confidence: regexConfidence };
  if (llm) return { value: llm, source: "llm", confidence: 0.7 };
  return none();
}

const same = (a: string | null, b: string | null) => !a || !b || partKey(a) === partKey(b);

export type ParseOptions = {
  llm: LlmExtractor | null;
  /** Treat the email as a work request even if it looks like something else (CDS asked for it). */
  forceWorkRequest?: boolean;
};

export async function parseEmail(email: NormalizedEmail, ref: IntakeReference, options: ParseOptions): Promise<ParsedEmail> {
  const text = bodyText(email);
  const all = `${email.subject}\n${text}`;
  const d = extractDeterministic(email.subject, text);
  const warnings: string[] = [];

  let ai: LlmExtraction | null = null;
  let llmModel: string | null = null;
  let llmError: string | null = null;
  if (options.llm) {
    const result = await options.llm({ email, text, deterministic: d });
    if (result.ok) {
      ai = result.value;
      llmModel = result.model;
    } else {
      llmError = result.error;
      warnings.push(`AI reading failed, pattern matching only: ${result.error}`);
    }
  } else {
    warnings.push("AI reading is not set up (no API key): pattern matching only, low confidence.");
  }

  // ---- work request or not
  const strongSignals = !!(d.unitNumber || d.poNumber) && d.components.length > 0;
  let isWorkRequest: boolean;
  let ignoreReason: string | null = null;
  if (options.forceWorkRequest) {
    isWorkRequest = true;
  } else if (ai) {
    isWorkRequest = ai.is_work_request || strongSignals;
    if (!ai.is_work_request && strongSignals) warnings.push("AI said this is not a work request, but it names a unit or PO and a part: kept for review.");
    if (!isWorkRequest) ignoreReason = ai.not_work_request_reason ?? "Not a work request";
  } else {
    isWorkRequest = !d.nonWorkReason;
    if (!isWorkRequest) ignoreReason = d.nonWorkReason;
  }

  // ---- customer, by the original author of a forwarded request first
  const from = emailAddress(email.from);
  // The AI's "original sender" counts only if that address is written in the email itself.
  const aiSenderRaw = emailAddress(ai?.original_sender_email);
  const aiSender = aiSenderRaw && all.toLowerCase().includes(aiSenderRaw) ? aiSenderRaw : null;
  const senders = [...new Set([...quotedSenders(text), ...(aiSender ? [aiSender] : []), ...(from ? [from] : [])])];
  const customer = matchCustomer({ senders, text: all, llmCustomerName: ai?.customer_name ?? null }, ref.customers, ref.domains);
  if (!customer.match) warnings.push(customer.candidates.length ? "More than one customer matches: pick one." : "Customer not recognised.");

  // ---- fields
  const po = pick(d.poNumber, ai?.po_number ?? null);
  const unit = pick(d.unitNumber, ai?.unit_number ?? null);
  if (!same(d.poNumber, ai?.po_number ?? null)) warnings.push(`PO differs: pattern found ${d.poNumber}, AI read ${ai?.po_number}.`);
  if (!same(d.unitNumber, ai?.unit_number ?? null)) warnings.push(`Unit differs: pattern found ${d.unitNumber}, AI read ${ai?.unit_number}.`);
  const aiVin = ai?.vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(ai.vin) ? ai.vin : null;
  const vin: Field<string> = d.vin
    ? { value: d.vin, source: "regex", confidence: d.vinValid ? 0.95 : 0.6 }
    : aiVin
      ? { value: aiVin, source: "llm", confidence: 0.6 }
      : none();
  if (d.vin && !d.vinValid) warnings.push("VIN check digit does not match: check the VIN.");
  const locationNumber = pick(d.locationNumbers[0] ?? null, ai?.location_number ?? null);
  const locationName = pick(null, ai?.location_name ?? null);
  const locationAddress = pick(null, ai?.location_address ?? null);

  // ---- location, within the matched customer only
  let locations: LocationRef[] = [];
  let location: ParsedEmail["location"] = null;
  let locationCandidates: ParsedEmail["location_candidates"] = [];
  if (customer.match) {
    locations = await ref.locationsFor(customer.match.id);
    const numbers = [...d.locationNumbers, ...(ai?.location_number ? [ai.location_number] : [])];
    const found = matchLocation(
      { numbers, name: ai?.location_name ?? null, address: ai?.location_address ?? null, zip: d.zip, text: all },
      locations,
    );
    location = found.match;
    locationCandidates = found.candidates.map((l) => ({ id: l.id, code: l.code, name: l.name }));
    if (!location) warnings.push(found.candidates.length ? "More than one location matches: pick one." : "Location not matched.");
  }

  // ---- pickup or shipping
  let fulfillment: Field<Fulfillment> = none();
  if (d.fulfillment !== "unspecified" && !d.fulfillmentConflict) fulfillment = { value: d.fulfillment, source: "regex", confidence: 0.8 };
  else if (ai && ai.fulfillment !== "unknown") fulfillment = { value: ai.fulfillment, source: "llm", confidence: 0.7 };
  else if (d.fulfillment !== "unspecified") fulfillment = { value: d.fulfillment, source: "regex", confidence: 0.5 };
  else {
    const loc = location ? locations.find((l) => l.id === location.id) : null;
    if (loc && (loc.fulfillment === "pickup" || loc.fulfillment === "shipping")) {
      fulfillment = { value: loc.fulfillment, source: "location_default", confidence: 0.6 };
    }
  }
  if (d.fulfillmentConflict) warnings.push("The email mentions both pickup and shipping: check the method.");

  // ---- requested services and parts
  const customerId = customer.match?.id ?? null;
  // Items priced per line (Misc. hardware) need an amount from the shop's invoice: never proposed.
  const catalog = matchableCatalog(ref.catalog);
  const catalogIds = new Set(catalog.map((c) => c.id));
  const known = [
    ...ref.aliases.filter((a) => a.customer_id === customerId && catalogIds.has(a.catalog_item_id)).map((a) => a.customer_part_number),
    ...catalog.map((c) => c.sku),
  ];
  const inputs: ItemInput[] = findKnownPartNumbers(text, known).map((p) => ({
    description: p.partNumber,
    partNumber: p.partNumber,
    qty: p.qty,
    component: null,
    source: "regex",
  }));
  for (const it of ai?.items ?? []) {
    if (it.part_number && inputs.some((i) => partKey(i.partNumber) === partKey(it.part_number))) {
      const existing = inputs.find((i) => partKey(i.partNumber) === partKey(it.part_number))!;
      existing.description = it.description || existing.description;
      if (it.quantity && existing.qty === 1) existing.qty = it.quantity;
      continue;
    }
    inputs.push({ description: it.description, partNumber: it.part_number, qty: it.quantity, component: it.component, source: "llm" });
  }
  const cleaning = (c: Component): ItemInput => ({ description: `${c} cleaning`, partNumber: null, qty: 1, component: c, source: "regex" });
  const categoryOf = new Map(catalog.map((c) => [c.id, c.category]));
  // Only components the text asks to have cleaned, in both paths: a component named in a part
  // description ("DOC clamp") or in a declined cleaning ("no cleaning") is not a cleaning.
  const cleanings = requestedCleanings(all);
  let items: ItemMatch[];
  if (!inputs.length) {
    items = cleanings.map((c) => matchItem(cleaning(c), customerId, catalog, ref.aliases));
  } else {
    items = inputs.map((i) => matchItem(i, customerId, catalog, ref.aliases));
    // A cleaning asked for in the text ("Work needed: DPF clean") is kept next to part numbers,
    // unless a matched service already covers that component.
    for (const c of cleanings) {
      const word = new RegExp(String.raw`\b${c}\b`, "i");
      const covered = items.some((i) => i.catalog_item_id && categoryOf.get(i.catalog_item_id) === "service" && word.test(`${i.name} ${i.sku}`));
      if (covered) continue;
      const m = matchItem(cleaning(c), customerId, catalog, ref.aliases);
      if (!m.catalog_item_id || !items.some((i) => i.catalog_item_id === m.catalog_item_id)) items.push(m);
    }
  }
  const unmatched = items.filter((i) => !i.catalog_item_id);
  if (unmatched.length) warnings.push(`${unmatched.length} requested item(s) not matched to the catalog.`);
  if (isWorkRequest && !items.length) warnings.push("No services or parts found: add the lines by hand.");
  // Items priced per line are never proposed, so say so when the email asks for one.
  const words = (v: string) => ` ${v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const allWords = words(all);
  const perLine = ref.perLineItems;
  const asked = perLine.filter((c) =>
    [c.name, c.sku, ...ref.aliases.filter((a) => a.catalog_item_id === c.id).map((a) => a.customer_part_number)].some(
      (n) => n && words(n).trim() && allWords.includes(words(n)),
    ),
  );
  for (const c of asked) warnings.push(`${c.name} is asked for: add it by hand with the amount from the shop's invoice.`);

  const matched = items.filter((i) => i.catalog_item_id);
  const requestType = matched.length > 0 && matched.every((i) => categoryOf.get(i.catalog_item_id!) !== "service") ? "parts_only" : "service";

  const summary =
    ai?.requested_work_summary ??
    (items.length ? items.map((i) => (i.qty > 1 ? `${i.qty} x ` : "") + (i.name ?? i.description)).join(", ") : null) ??
    null;
  const requestedWork: Field<string> = summary
    ? { value: summary, source: ai?.requested_work_summary ? "llm" : "regex", confidence: ai ? 0.7 : 0.5 }
    : { value: email.subject || null, source: email.subject ? "regex" : "none", confidence: 0.3 };

  const notesText = [ai?.notes, ai?.contact_name ? `Contact: ${ai.contact_name}` : null].filter(Boolean).join(" ");
  const notes: Field<string> = notesText ? { value: notesText, source: "llm", confidence: 0.7 } : none();

  // ---- confidence
  const itemScore = items.length ? items.reduce((s, i) => s + i.confidence, 0) / items.length : 0;
  let confidence =
    0.3 * (customer.match?.confidence ?? 0) +
    0.25 * (location?.confidence ?? 0) +
    0.2 * unit.confidence +
    0.15 * itemScore +
    0.1 * po.confidence;
  if (!ai) confidence = Math.min(confidence, DETERMINISTIC_ONLY_CAP);
  confidence = Math.round(confidence * 100) / 100;

  return {
    version: 1,
    is_work_request: isWorkRequest,
    ignore_reason: ignoreReason,
    original_sender: senders[0] ?? null,
    llm: { used: !!ai, model: llmModel, error: llmError },
    fields: {
      po_number: po,
      unit_number: unit,
      vin,
      location_number: locationNumber,
      location_name: locationName,
      location_address: locationAddress,
      fulfillment,
      requested_work: requestedWork,
      notes,
    },
    customer: customer.match,
    customer_candidates: customer.candidates.map((c) => ({ id: c.id, name: c.name })),
    location,
    location_candidates: locationCandidates,
    items,
    request_type: requestType,
    confidence,
    confidence_label: confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low",
    warnings,
  };
}
