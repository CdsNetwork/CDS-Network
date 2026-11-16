"use client";

import type { ReactNode } from "react";

/**
 * Submits the surrounding form when a select or checkbox inside changes, so filters and
 * status selects apply without a separate button. Text fields still wait for their button.
 */
export function SubmitOnChange({ children }: { children: ReactNode }) {
  return (
    <span
      style={{ display: "contents" }}
      onChange={(e) => {
        const field = e.target as HTMLInputElement | HTMLSelectElement;
        if (field instanceof HTMLSelectElement || (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio"))) {
          field.form?.requestSubmit();
        }
      }}
    >
      {children}
    </span>
  );
}
