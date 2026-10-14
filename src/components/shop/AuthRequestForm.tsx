"use client";

import { useState } from "react";
import { ActionForm } from "./ActionForm";
import type { ActionState, Option } from "./types";

export function AuthRequestForm({
  action,
  options,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  options: (Option & { kind: "service" | "part" })[];
}) {
  const [itemId, setItemId] = useState("");
  const kind = options.find((o) => o.id === itemId)?.kind;

  return (
    <ActionForm action={action} submitLabel="Submit Authorization Request" pendingLabel="Submitting..." resetOnSuccess onSuccess={() => setItemId("")}>
      <div className="grid2">
        <div>
          <div className="field">
            <label htmlFor="ar-item">
              Service / Part <span className="req">*</span>
            </label>
            <select id="ar-item" name="catalog_item" required value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">Select from the CDS catalog...</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ width: 110 }}>
              <label htmlFor="ar-qty">Qty</label>
              <input
                className="input"
                id="ar-qty"
                name="qty"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="any"
                defaultValue={1}
              />
            </div>
            <div className="field">
              <label>Request type</label>
              <span className="pill">{kind === "service" ? "Service" : kind === "part" ? "Part" : "Pick an item"}</span>
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="ar-note">
            Reason / Notes <span className="req">*</span>
          </label>
          <textarea
            id="ar-note"
            name="note"
            rows={4}
            required
            placeholder="Describe what was found and why approval is needed"
          />
        </div>
      </div>
    </ActionForm>
  );
}
