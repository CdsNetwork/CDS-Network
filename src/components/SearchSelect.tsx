"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

export type SearchOption = {
  value: string;
  label: string;
  /** Second line, also searched (city, capabilities, price). */
  hint?: string;
  /** Extra words that match but are not shown (OE numbers, ZIP codes). */
  keywords?: string;
  disabled?: boolean;
};

type Props = {
  options: SearchOption[];
  /** Name of the hidden input that carries the chosen value in a form. */
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string, option: SearchOption | null) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  /** Rows shown at once. */
  limit?: number;
  emptyText?: string;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Type-to-search picker for long lists (catalog, parts, shops). Every word typed must match
 * the label, hint or keywords. Arrow keys move, Enter picks, Escape closes.
 */
export function SearchSelect({
  options,
  name,
  value,
  defaultValue = "",
  onChange,
  placeholder = "Type to search...",
  required,
  disabled,
  id,
  limit = 60,
  emptyText = "No matches",
}: Props) {
  const autoId = useId();
  const inputId = id ?? `search-${autoId}`;
  const listId = `${inputId}-list`;
  const [inner, setInner] = useState(defaultValue);
  const selected = value ?? inner;
  const selectedOption = options.find((o) => o.value === selected) ?? null;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A required picker blocks the form until an option is actually chosen, even if text was typed.
  useEffect(() => {
    inputRef.current?.setCustomValidity(required && !selected ? "Pick one from the list." : "");
  }, [required, selected]);

  const index = useMemo(
    () => options.map((o) => ({ o, text: norm(`${o.label} ${o.hint ?? ""} ${o.keywords ?? ""}`) })),
    [options],
  );
  const matches = useMemo(() => {
    const words = norm(query).split(" ").filter(Boolean);
    const hits = words.length ? index.filter(({ text }) => words.every((w) => text.includes(w))) : index;
    return hits.slice(0, limit).map(({ o }) => o);
  }, [index, query, limit]);

  function choose(o: SearchOption | null) {
    if (o?.disabled) return;
    const v = o?.value ?? "";
    if (value === undefined) setInner(v);
    onChange?.(v, o);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (matches[active]) choose(matches[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div style={{ position: "relative" }}>
      {name && <input type="hidden" name={name} value={selected} />}
      <input
        ref={inputRef}
        id={inputId}
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        placeholder={selectedOption ? selectedOption.label : placeholder}
        value={open ? query : selectedOption?.label ?? ""}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => {
            setOpen(false);
            setQuery("");
          }, 150);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="suggestions" id={listId} role="listbox">
          {matches.length === 0 ? (
            <div className="suggestion small">{emptyText}</div>
          ) : (
            matches.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === selected}
                disabled={o.disabled}
                className={`suggestion${i === active || o.value === selected ? " active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                  choose(o);
                }}
              >
                <strong>{o.label}</strong>
                {o.hint && <div className="small">{o.hint}</div>}
              </button>
            ))
          )}
          {matches.length === limit && (
            <div className="suggestion small">Showing the first {limit}. Type more to narrow it down.</div>
          )}
        </div>
      )}
    </div>
  );
}
