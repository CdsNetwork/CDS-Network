"use client";

import { useState } from "react";
import { ActionForm } from "./ActionForm";
import { CatalogPicker } from "./CatalogPicker";
import type { ActionState, CatalogOption } from "./types";

export function AddPartForm({
  action,
  options,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  options: CatalogOption[];
}) {
  const [itemId, setItemId] = useState("");
  return (
    <ActionForm
      action={action}
      submitLabel="+ Add Part"
      pendingLabel="Adding..."
      resetOnSuccess
      onSuccess={() => setItemId("")}
    >
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "1 1 220px" }}>
          <label htmlFor="part-item">
            Part <span className="req">*</span>
          </label>
          <CatalogPicker
            id="part-item"
            options={options}
            value={itemId}
            onChange={setItemId}
            placeholder="Search SKU, part name or OE number..."
          />
        </div>
        <div className="field" style={{ width: 90 }}>
          <label htmlFor="part-qty">Qty</label>
          <input
            className="input"
            id="part-qty"
            name="qty"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="any"
            defaultValue={1}
            required
          />
        </div>
      </div>
      <div className="notice warning" style={{ margin: "4px 0 0" }}>
        Select from the CDS catalog; prices cannot be typed manually by the affiliate.
      </div>
      <p className="small">
        Parts include gaskets, clamps, bungs and other CDS catalog parts. Services cannot be added here: if more work is
        needed, use Request Additional Authorization below.
      </p>
    </ActionForm>
  );
}
