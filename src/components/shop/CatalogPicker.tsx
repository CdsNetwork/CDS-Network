"use client";

import { useMemo } from "react";
import { SearchSelect, type SearchOption } from "@/components/SearchSelect";
import type { CatalogOption } from "./types";

/**
 * Type-to-search catalog picker for a phone in the workshop: matches SKU, name, category,
 * the rate text and OE cross reference numbers. Posts the item id as `catalog_item`.
 */
export function CatalogPicker({
  id,
  options,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  options: CatalogOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const searchOptions = useMemo<SearchOption[]>(
    () => options.map((o) => ({ value: o.id, label: o.label, hint: o.hint, keywords: o.keywords })),
    [options],
  );
  return (
    <SearchSelect
      id={id}
      name="catalog_item"
      options={searchOptions}
      value={value}
      onChange={(v) => onChange(v)}
      placeholder={placeholder}
      required
      emptyText="No catalog item matches. Try the SKU, part name or OE number."
    />
  );
}
