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
  // Misc. hardware: a description and the amount on the shop's invoice instead of a quantity.
  const perLine = options.find((o) => o.id === itemId)?.perLine === true;
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
        {perLine ? (
          <>
            <input type="hidden" name="per_line" value="1" />
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="part-description">
                Description <span className="req">*</span>
              </label>
              <input className="input" id="part-description" name="description" maxLength={500} required placeholder="For example: bolts and nuts for the DPF kit" />
            </div>
            <div className="field" style={{ width: 130 }}>
              <label htmlFor="part-amount">
                Amount on your invoice <span className="req">*</span>
              </label>
              <input className="input" id="part-amount" name="amount" inputMode="decimal" required placeholder="0.00" />
            </div>
          </>
        ) : (
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
        )}
      </div>
      <div className="notice warning" style={{ margin: "4px 0 0" }}>
        Select from the CDS catalog; prices cannot be typed manually by the affiliate, except the amount of misc. hardware
        from your invoice.
      </div>
      <p className="small">
        Add any parts the job used (gaskets, clamps, bungs, misc. hardware and other CDS catalog parts): no
        approval needed. Services and extra labor cannot be added here: use Request Additional Authorization below.
      </p>
    </ActionForm>
  );
}
