import type { LocationOption } from "./NewWorkOrderForm";

/** Matching and ordering for the Location / Branch picker. Safe on server and client. */

const MAX_SUGGESTIONS = 80;

function codeNumber(l: LocationOption): number {
  const m = (l.location_number ?? l.code).match(/\d+/);
  return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
}

const byNumber = (a: LocationOption, b: LocationOption) => codeNumber(a) - codeNumber(b) || a.code.localeCompare(b.code);

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Everything a location can be found by besides its code and name: address, city, state, ZIP. */
function addressText(l: LocationOption): string {
  return norm(`${l.address_raw} ${l.city ?? ""} ${l.region ?? ""} ${l.postal_code ?? ""}`);
}

/**
 * Codes that start with the query first, then code or name containing it, then address,
 * city, state or ZIP matches (every typed word must match); each group sorted by number.
 */
export function matchLocations(all: LocationOption[], query: string): LocationOption[] {
  const q = norm(query);
  if (!q) return [...all].sort(byNumber).slice(0, MAX_SUGGESTIONS);
  const prefix = all.filter((l) => l.code.toLowerCase().startsWith(q) || (l.location_number ?? "").toLowerCase().startsWith(q));
  const taken = new Set(prefix);
  const named = all.filter((l) => !taken.has(l) && (l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)));
  for (const l of named) taken.add(l);
  const words = q.split(" ");
  const other = all.filter((l) => {
    if (taken.has(l)) return false;
    const text = `${norm(l.code)} ${norm(l.name)} ${addressText(l)}`;
    return words.every((w) => text.includes(w));
  });
  return [...prefix.sort(byNumber), ...named.sort(byNumber), ...other.sort(byNumber)].slice(0, MAX_SUGGESTIONS);
}

/**
 * The picker's list: with nothing typed, the locations the email intake matched come first
 * (in number order), then the rest. Typed text matches as in matchLocations.
 */
export function orderLocationSuggestions(all: LocationOption[], query: string, candidateIds: string[]): LocationOption[] {
  if (norm(query) || !candidateIds.length) return matchLocations(all, query);
  const wanted = new Set(candidateIds);
  const first = all.filter((l) => wanted.has(l.id)).sort(byNumber);
  const rest = all.filter((l) => !wanted.has(l.id));
  return [...first, ...matchLocations(rest, "")].slice(0, MAX_SUGGESTIONS);
}
