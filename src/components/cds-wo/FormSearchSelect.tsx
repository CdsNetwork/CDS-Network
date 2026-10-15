"use client";

import { useEffect, useRef, useState } from "react";
import { SearchSelect, type SearchOption } from "@/components/SearchSelect";

type Props = {
  options: SearchOption[];
  name: string;
  id?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  limit?: number;
  emptyText?: string;
};

/**
 * SearchSelect for a plain form field: carries the value in a hidden input and returns to
 * its default when the form is reset (ActionForm resets "add" forms after a save).
 */
export function FormSearchSelect({ defaultValue = "", ...props }: Props) {
  const [value, setValue] = useState(defaultValue);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = box.current?.closest("form");
    if (!form) return;
    const onReset = () => setValue(defaultValue);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [defaultValue]);

  return (
    <div ref={box}>
      <SearchSelect {...props} value={value} onChange={(v) => setValue(v)} />
    </div>
  );
}
