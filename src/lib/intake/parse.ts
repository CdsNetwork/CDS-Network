/**
 * The intake pipeline for one email. A request template (Ryder form, First Student iProcure
 * PO, website form) is read exactly, without the AI stage. Otherwise the ignore rules
 * (replies, invoices, carrier notices, CDS's own mail) are checked, then deterministic
 * extraction, then the AI stage for the rest (when configured), then matching to customers,
 * locations and catalog items in code. Pure apart from the reference data and the AI call,
 * both passed in.
 */
import { INBOX_CUSTOMERS } from "./config";
import { bodyText, emailAddress, intakeMailbox, quotedSenders } from "./email";
import { extractDeterministic, findKnownPartNumbers, requestedCleanings, vinCheckDigitOk } from "./extract";
import { ignoreRule, type IgnoreMatch } from "./ignore";
import type { LlmExtraction, LlmExtractor } from "./llm";
import { matchCustomer, matchItem, matchLocation, partKey, type CustomerHint, type ItemInput } from "./match";
import { detectTemplate, type TemplateResult } from "./templates";
import { matchableCatalog, type CatalogRef, type Component, type Field, type Fulfillment, type IntakeReference, type ItemMatch, type LocationRef, type NormalizedEmail, type ParsedEmail } from "./types";

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

/** Customers named by the inbox the email was addressed to (xpo@ is XPO, the ryder@ group is Ryder). */
function inboxHints(email: NormalizedEmail): CustomerHint[] {
  const addresses = [email.deliveredTo, ...email.to].map((a) => emailAddress(a)).filter((a): a is string => !!a);
  return [...new Set(addresses)]
    .filter((a) => INBOX_CUSTOMERS[a])
    .map((a) => ({ codes: INBOX_CUSTOMERS[a], names: INBOX_CUSTOMERS[a], via: "inbox" as const }));
}

const label = (confidence: number): ParsedEmail["confidence_label"] => (confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low");

export async function parseEmail(email: NormalizedEmail, ref: IntakeReference, options: ParseOptions): Promise<ParsedEmail> {
  const text = bodyText(email);
  const template = detectTemplate(email, text);
  if (template) return parseTemplate(email, text, template, ref);
  if (!options.forceWorkRequest) {
    const ignore = ignoreRule(email, text);
    if (ignore) return ignored(email, ignore);
  }

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
  const customer = matchCustomer(
    { senders, text: all, llmCustomerName: ai?.customer_name ?? null, hints: inboxHints(email) },
    ref.customers,
    ref.domains,
  );
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
  // "QTY. 1 A6809999 DPF MODULE" (XPO): the part on the line, or its cleaning.
  const qtyKeys = new Set(d.qtyLines.map((q) => partKey(q.partNumber)));
  const qtyItems: ItemMatch[] = d.qtyLines
    .filter((q) => d.forCleaning || !inputs.some((i) => partKey(i.partNumber) === partKey(q.partNumber)))
    .map((q) =>
      d.forCleaning
        ? {
            ...matchItem({ description: `${q.component} cleaning`, partNumber: null, qty: q.qty, component: q.component, source: "regex" }, customerId, catalog, ref.aliases),
            part_number: q.partNumber,
          }
        : matchItem({ description: `${q.partNumber} ${q.component}`, partNumber: q.partNumber, qty: q.qty, component: null, source: "regex" }, customerId, catalog, ref.aliases),
    );
  for (const it of ai?.items ?? []) {
    if (it.part_number && qtyKeys.has(partKey(it.part_number))) continue;
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
  const items: ItemMatch[] = [...inputs.map((i) => matchItem(i, customerId, catalog, ref.aliases)), ...qtyItems];
  {
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
    ignore_kind: null,
    template: null,
    mailbox: intakeMailbox(email),
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
      ...(d.mileage !== null ? { mileage: { value: d.mileage, source: "regex" as const, confidence: 0.9 } } : {}),
    },
    customer: customer.match,
    customer_candidates: customer.candidates.map((c) => ({ id: c.id, name: c.name })),
    location,
    location_candidates: locationCandidates,
    items,
    request_type: requestType,
    confidence,
    confidence_label: label(confidence),
    warnings,
  };
}

function emptyFields(): ParsedEmail["fields"] {
  return {
    po_number: none(),
    unit_number: none(),
    vin: none(),
    location_number: none(),
    location_name: none(),
    location_address: none(),
    fulfillment: none(),
    requested_work: none(),
    notes: none(),
  };
}

/** Not a request: stored as ignored with the reason, without the AI stage. */
function ignored(email: NormalizedEmail, rule: IgnoreMatch): ParsedEmail {
  const fields = emptyFields();
  if (rule.poNumber) fields.po_number = { value: rule.poNumber, source: "regex", confidence: 0.95 };
  return {
    version: 1,
    is_work_request: false,
    ignore_reason: rule.reason,
    ignore_kind: rule.kind,
    template: null,
    mailbox: intakeMailbox(email),
    original_sender: emailAddress(email.from),
    llm: { used: false, model: null, error: null },
    fields,
    customer: null,
    customer_candidates: [],
    location: null,
    location_candidates: [],
    items: [],
    request_type: "service",
    confidence: 0,
    confidence_label: "low",
    warnings: [],
  };
}

// ---------------------------------------------------------------- request templates

const TEMPLATE_CONFIDENCE = 0.98;
const TEMPLATE_LABEL: Record<TemplateResult["template"], string> = {
  ryder: "Ryder pick up request",
  first_student_iprocure: "First Student iProcure PO",
  website_form: "website fleet request",
};

/** A clamp and gasket kit, or a clamp or gasket on its own. */
const isKit = (c: CatalogRef) => /^CDS-KIT-/i.test(c.sku) || c.category === "clamp" || c.category === "gasket" || /\bkit\b/i.test(c.name);

/** A template email: every field read exactly, matched in code, no AI stage. */
async function parseTemplate(email: NormalizedEmail, text: string, t: TemplateResult, ref: IntakeReference): Promise<ParsedEmail> {
  const all = `${email.subject}\n${text}`;
  const warnings = [...t.warnings];
  const exact = <T>(value: T | undefined | null): Field<T> =>
    value === undefined || value === null ? none<T>() : { value, source: "template", confidence: TEMPLATE_CONFIDENCE };
  const f = t.fields;

  const from = emailAddress(email.from);
  const customer = matchCustomer(
    { senders: from ? [from] : [], text: all, llmCustomerName: null, hints: [{ ...t.customer, via: "template" }, ...inboxHints(email)] },
    ref.customers,
    ref.domains,
  );
  if (!customer.match) {
    warnings.push(
      customer.candidates.length
        ? `More than one customer matches "${t.customer.label}": pick one.`
        : `Customer not recognised: the ${TEMPLATE_LABEL[t.template]} names "${t.customer.label}".`,
    );
  }

  let locations: LocationRef[] = [];
  let location: ParsedEmail["location"] = null;
  let locationCandidates: ParsedEmail["location_candidates"] = [];
  if (customer.match) {
    locations = await ref.locationsFor(customer.match.id);
    const zip = f.location_address?.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] ?? null;
    const found = matchLocation(
      { numbers: f.location_number ? [f.location_number] : [], name: f.location_name ?? null, address: f.location_address ?? null, zip, text: f.location_address ?? "" },
      locations,
    );
    location = found.match;
    locationCandidates = found.candidates.map((l) => ({ id: l.id, code: l.code, name: l.name }));
    if (!location) warnings.push(found.candidates.length ? "More than one location matches: pick one." : "Location not matched.");
  }

  // ---- lines
  const customerId = customer.match?.id ?? null;
  const catalog = matchableCatalog(ref.catalog);
  const categoryOf = new Map(catalog.map((c) => [c.id, c.category]));
  const items: ItemMatch[] = [];
  const unchosenKits: string[] = [];
  for (const it of t.items) {
    const input: ItemInput = { description: it.description, partNumber: it.partNumber, qty: it.qty, component: it.component, source: "template" };
    let m: ItemMatch;
    if (it.kit) {
      // The kit depends on the engine: only a Part # that names a kit picks one.
      const byPart = it.partNumber ? matchItem({ ...input, component: null }, customerId, catalog, ref.aliases) : null;
      const item = byPart?.catalog_item_id ? catalog.find((c) => c.id === byPart.catalog_item_id) : null;
      if (!byPart || !item || !isKit(item) || byPart.via === "name") {
        unchosenKits.push(it.description);
        warnings.push(
          `${it.description} asked for: the clamp and gasket kit depends on the unit${
            f.manufacturer || it.partNumber ? ` (${[f.manufacturer && `Manufacturer ${f.manufacturer}`, it.partNumber && `Part # ${it.partNumber}`].filter(Boolean).join(", ")})` : ""
          }. Add the matching kit by hand.`,
        );
        continue;
      }
      m = { ...byPart, confidence: 0.95 };
    } else if (it.sku && catalog.some((c) => partKey(c.sku) === partKey(it.sku))) {
      const c = catalog.find((x) => partKey(x.sku) === partKey(it.sku))!;
      m = { description: it.description, part_number: null, qty: it.qty, catalog_item_id: c.id, sku: c.sku, name: c.name, via: "sku", source: "template", confidence: TEMPLATE_CONFIDENCE };
    } else {
      m = matchItem(input, customerId, catalog, ref.aliases);
    }
    items.push({
      ...m,
      ...(it.price !== undefined ? { price: it.price } : {}),
      ...(it.requiredDate !== undefined ? { required_date: it.requiredDate } : {}),
      ...(it.taxable !== undefined ? { taxable: it.taxable } : {}),
      ...(it.costCenter !== undefined ? { cost_center: it.costCenter } : {}),
      ...(it.returnToLocation ? { return_to_location: true } : {}),
    });
  }
  const unmatched = items.filter((i) => !i.catalog_item_id);
  if (unmatched.length) warnings.push(`${unmatched.length} requested item(s) not matched to the catalog: ${unmatched.map((i) => i.part_number ?? i.description).join(", ")}.`);
  if (!items.length && !unchosenKits.length) warnings.push("No services or parts found: add the lines by hand.");

  // PO prices against the customer's portal price.
  if (customerId && ref.priceFor) {
    for (const i of items) {
      if (i.price === undefined || i.price === null || !i.catalog_item_id) continue;
      const portal = await ref.priceFor(customerId, i.catalog_item_id);
      i.portal_price = portal;
      if (portal !== null && Math.abs(portal - i.price) > 0.005) {
        warnings.push(`PO price for ${i.sku} is ${i.price.toFixed(2)}, the portal price for this customer is ${portal.toFixed(2)}: check before invoicing.`);
      }
    }
  }

  const matched = items.filter((i) => i.catalog_item_id);
  const partsOnly = matched.length > 0 && matched.every((i) => categoryOf.get(i.catalog_item_id!) !== "service");
  const requestType = partsOnly && !t.items.some((i) => i.service) ? "parts_only" : "service";

  // ---- pickup or shipping: the template's own, a parts order ships, else the location default
  let fulfillment: Field<Fulfillment> = none();
  if (f.fulfillment) fulfillment = exact(f.fulfillment);
  else if (t.template === "first_student_iprocure" && requestType === "parts_only") fulfillment = { value: "shipping", source: "template", confidence: 0.9 };
  else {
    const loc = location ? locations.find((l) => l.id === location.id) : null;
    if (loc && (loc.fulfillment === "pickup" || loc.fulfillment === "shipping")) {
      fulfillment = { value: loc.fulfillment, source: "location_default", confidence: 0.6 };
    }
  }

  let vin: Field<string> = none();
  if (f.vin) {
    const valid = vinCheckDigitOk(f.vin);
    vin = { value: f.vin, source: "template", confidence: valid ? TEMPLATE_CONFIDENCE : 0.6 };
    if (!valid) warnings.push("VIN check digit does not match: check the VIN.");
  }

  const work = [
    ...items.map((i) => (i.qty > 1 ? `${i.qty} x ` : "") + (i.name ?? i.description) + (i.return_to_location ? " (return to the location)" : "")),
    ...unchosenKits.map((k) => `${k} (kit to be chosen by CDS)`),
  ].join(", ");
  const requestedWork: Field<string> = work
    ? { value: f.comments ? `${work}. Customer comments: ${f.comments}` : work, source: "template", confidence: TEMPLATE_CONFIDENCE }
    : { value: email.subject || null, source: email.subject ? "regex" : "none", confidence: 0.3 };

  const unit = exact(f.unit_number);
  const po = exact(f.po_number);
  const itemScore = items.length ? items.reduce((s, i) => s + i.confidence, 0) / items.length : 0;
  const confidence =
    Math.round(
      (0.3 * (customer.match?.confidence ?? 0) +
        0.25 * (location?.confidence ?? 0) +
        0.2 * unit.confidence +
        0.15 * itemScore +
        0.1 * po.confidence) *
        100,
    ) / 100;

  return {
    version: 1,
    is_work_request: true,
    ignore_reason: null,
    ignore_kind: null,
    template: t.template,
    mailbox: intakeMailbox(email),
    original_sender: from,
    llm: { used: false, model: null, error: null },
    fields: {
      po_number: po,
      unit_number: unit,
      vin,
      location_number: exact(f.location_number),
      location_name: exact(f.location_name),
      location_address: exact(f.location_address),
      fulfillment,
      requested_work: requestedWork,
      notes: exact(f.comments),
      requested_date: exact(f.requested_date),
      order_type: exact(f.order_type),
      region: exact(f.region),
      mileage: exact(f.mileage),
      serial_number: exact(f.serial_number),
      manufacturer: exact(f.manufacturer),
      part_number: exact(f.part_number),
      comments: exact(f.comments),
      contact_name: exact(f.contact_name),
      contact_email: exact(f.contact_email),
      contact_phone: exact(f.contact_phone),
      store_room: exact(f.store_room),
      pickup_option: exact(f.pickup_option),
      filter_options: exact(f.filter_options),
      parts_or_service: exact(f.parts_or_service),
      cost_center: exact(f.cost_center),
      order_description: exact(f.order_description),
      location_suffix: exact(f.location_suffix),
      return_to_location: exact(f.return_to_location),
    },
    customer: customer.match,
    customer_candidates: customer.candidates.map((c) => ({ id: c.id, name: c.name })),
    location,
    location_candidates: locationCandidates,
    items,
    request_type: requestType,
    confidence,
    confidence_label: label(confidence),
    warnings,
  };
}
