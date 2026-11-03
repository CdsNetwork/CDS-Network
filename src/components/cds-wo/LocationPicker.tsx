"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { FULFILLMENT_LABEL } from "@/lib/format";
import { matchLocations, orderLocationSuggestions } from "./location-match";
import type { LocationOption } from "./NewWorkOrderForm";

type Props = {
  /** The chosen customer; the picker is off until there is one. */
  customerId: string;
  /** The chosen customer's locations. */
  locations: LocationOption[];
  location: LocationOption | null;
  query: string;
  onQueryChange: (query: string) => void;
  onChoose: (location: LocationOption) => void;
  /** Typing clears the chosen location. */
  onClear: () => void;
  /** Locations the email intake matched: listed first. */
  candidateIds?: string[];
  inputId?: string;
};

/** The Location / Branch picker of Create Work Order and the Edit order box. */
export function LocationPicker({
  customerId,
  locations,
  location,
  query,
  onQueryChange,
  onChoose,
  onClear,
  candidateIds = [],
  inputId = "location_text",
}: Props) {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestions = useMemo(() => orderLocationSuggestions(locations, query, candidateIds), [locations, query, candidateIds]);
  const candidates = useMemo(() => new Set(candidateIds), [candidateIds]);
  const listId = `${inputId}-suggestions`;

  function choose(l: LocationOption) {
    onChoose(l);
    setOpen(false);
  }

  let helper: ReactNode = "Start typing a location number, name, address, city, state or ZIP. Location number matches come first, sorted numerically.";
  if (!customerId) helper = "Choose a customer first.";
  else if (location)
    helper = (
      <>
        <b>Auto-routed:</b> {location.shopName ?? "No default shop"} • {FULFILLMENT_LABEL[location.fulfillment]}
        {location.routing_notes && (
          <>
            <br />
            {location.routing_notes}
          </>
        )}
        {location.dock_note && (
          <>
            <br />
            Dock: {location.dock_note}
          </>
        )}
      </>
    );
  else if (query) helper = "Select a suggested location to load shop routing. Unmatched locations are held for review.";
  else if (candidates.size) helper = "The email matched more than one location. They are listed first.";

  return (
    <div className="field" style={{ position: "relative" }}>
      <label htmlFor={inputId}>
        Location / Branch <span className="req">*</span>
      </label>
      <input
        id={inputId}
        name="location_text"
        className="input"
        autoComplete="off"
        placeholder="Type location #, name, city or ZIP..."
        maxLength={200}
        disabled={!customerId}
        required
        value={query}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onChange={(e) => {
          const value = e.target.value;
          onQueryChange(value);
          onClear();
          setOpen(true);
          const exact = matchLocations(locations, value).filter((l) => l.code.toLowerCase().startsWith(value.trim().toLowerCase()));
          if (value.trim() && exact.length === 1 && exact[0].code.toLowerCase() === value.trim().toLowerCase()) {
            choose(exact[0]);
          }
        }}
      />
      {open && customerId && (
        <div className="suggestions" id={listId} role="listbox">
          {suggestions.length === 0 ? (
            <div className="suggestion small">No matching locations</div>
          ) : (
            suggestions.map((l) => (
              <button
                type="button"
                key={l.id}
                role="option"
                aria-selected={location?.id === l.id}
                className={`suggestion${location?.id === l.id ? " active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  choose(l);
                }}
              >
                <b>{l.code}</b>
                {candidates.has(l.id) && <span className="small"> • Matched by the email</span>}
                <div className="small">
                  {l.name} • {l.shopName ?? "No default shop"} • {FULFILLMENT_LABEL[l.fulfillment]}
                </div>
                {l.address_raw && <div className="small">{l.address_raw}</div>}
              </button>
            ))
          )}
        </div>
      )}
      <div className="small" style={{ marginTop: 5 }}>
        {helper}
      </div>
    </div>
  );
}
