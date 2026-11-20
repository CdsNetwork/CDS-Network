"use client";

import { useState } from "react";
import { ActionButton, ActionForm } from "./ActionForm";
import { manufacturerOptions } from "@/lib/manufacturers";
import { componentLabel, condemnedPhotoRequired, measurementsRequired, type ActionState, type ComponentRow } from "./types";

const fmt = (v: number | null) => (v === null ? "" : String(v));

function NumberField({
  id,
  name,
  label,
  required,
  value,
  step,
  min,
  onChange,
  suffix,
}: {
  id: string;
  name: string;
  label: string;
  required: boolean;
  value?: string;
  step: string;
  min: string;
  onChange?: (v: string) => void;
  suffix?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} {required && <span className="req">*</span>}
      </label>
      <input
        className="input"
        id={id}
        name={name}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        defaultValue={value}
        placeholder={suffix}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      />
    </div>
  );
}

export function ComponentCard({
  component: c,
  photoCount,
  saveAction,
  deleteAction,
}: {
  component: ComponentRow;
  photoCount: number;
  saveAction: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  deleteAction: (prev: ActionState) => Promise<ActionState>;
}) {
  const isEgr = c.component_type === "EGR";
  const [result, setResult] = useState(c.result ?? "");
  const measured = measurementsRequired(c.component_type, result);
  const [wBefore, setWBefore] = useState(fmt(c.weight_before_g));
  const [wAfter, setWAfter] = useState(fmt(c.weight_after_g));
  // True once a field was edited and not yet saved, so the shop sees that Save is still needed.
  const [dirty, setDirty] = useState(false);

  const removed =
    wBefore !== "" && wAfter !== "" && Number.isFinite(Number(wBefore) - Number(wAfter))
      ? `${Math.round((Number(wBefore) - Number(wAfter)) * 10) / 10} g`
      : "";
  const needsReason = result === "condemned";
  // A condemned EGR cooler needs no photo (Sarah, CDS, 2026-11-17).
  const needsPhoto = condemnedPhotoRequired(c.component_type, result);
  const key = (f: string) => `c-${c.id}-${f}`;

  return (
    <div className="component">
      <div className="row between" style={{ alignItems: "center", marginBottom: 8 }}>
        <strong>{componentLabel(c)}</strong>
        <ActionButton
          action={deleteAction}
          label="Remove"
          pendingLabel="Removing..."
          className="remove"
          confirmText={`Remove ${componentLabel(c)} and its entered data?`}
        />
      </div>
      <ActionForm
        action={saveAction}
        submitLabel="Save"
        submitClass="btn btn-secondary"
        successText="Saved."
        onChange={() => setDirty(true)}
        onSuccess={() => setDirty(false)}
        footer={dirty ? <span className="small" style={{ fontWeight: 700 }}>Not saved yet</span> : null}
      >
        <input type="hidden" name="component_type" value={c.component_type} />
        <div className="grid3">
          {/* A list since 2026-11-20 (Sarah, CDS); an older typed value stays as an extra choice. */}
          <input type="hidden" name="manufacturer_saved" value={c.manufacturer ?? ""} />
          <div className="field">
            <label htmlFor={key("manufacturer")}>
              Manufacturer <span className="req">*</span>
            </label>
            <select id={key("manufacturer")} name="manufacturer" defaultValue={c.manufacturer?.trim() ?? ""}>
              <option value="">Select manufacturer...</option>
              {manufacturerOptions(c.manufacturer).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {(
            [
              ["part_number", "Part Number", c.part_number],
              ["serial_number", "Serial Number", c.serial_number],
            ] as const
          ).map(([name, label, value]) => (
            <div className="field" key={name}>
              <label htmlFor={key(name)}>
                {label} <span className="req">*</span>
              </label>
              <input className="input" id={key(name)} name={name} defaultValue={value ?? ""} autoComplete="off" maxLength={100} />
            </div>
          ))}
          {!isEgr && (
            <>
              <NumberField
                id={key("dp_before")}
                name="dp_before"
                label="Differential Pressure: Before"
                required={measured}
                value={fmt(c.dp_before)}
                step="any"
                min="0"
                suffix="e.g. 2.5"
              />
              <NumberField
                id={key("dp_after")}
                name="dp_after"
                label="Differential Pressure: After"
                required={measured}
                value={fmt(c.dp_after)}
                step="any"
                min="0"
                suffix="e.g. 0.8"
              />
              <NumberField
                id={key("weight_before_g")}
                name="weight_before_g"
                label="Weight Before (g)"
                required={measured}
                value={wBefore}
                step="any"
                min="0"
                suffix="grams"
                onChange={setWBefore}
              />
              <NumberField
                id={key("weight_after_g")}
                name="weight_after_g"
                label="Weight After (g)"
                required={measured}
                value={wAfter}
                step="any"
                min="0"
                suffix="grams"
                onChange={setWAfter}
              />
              <div className="field">
                <label htmlFor={key("removed")}>Weight Removed</label>
                <input className="input calc" id={key("removed")} readOnly value={removed} tabIndex={-1} />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor={key("result")}>
              {isEgr ? "Result (Pass / Condemned)" : "Component Result"} <span className="req">*</span>
            </label>
            <select id={key("result")} name="result" value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="">Select result...</option>
              {isEgr ? (
                <>
                  <option value="passed">Pass</option>
                  <option value="condemned">Condemned</option>
                </>
              ) : (
                <>
                  <option value="cleaned">Cleaned Successfully</option>
                  <option value="condemned">Condemned</option>
                </>
              )}
            </select>
          </div>
        </div>
        {needsReason && (
          <div className="notice warning">
            <div className="field">
              <label htmlFor={key("note")}>
                Condemn Reason <span className="req">*</span>
              </label>
              <textarea id={key("note")} name="result_note" rows={2} required maxLength={2000} defaultValue={c.result_note ?? ""} />
            </div>
            {needsPhoto ? (
              <p className="small" style={{ color: "inherit", margin: 0 }}>
                <strong>Damage / Condition Photo *</strong>{" "}
                {photoCount > 0
                  ? `${photoCount} photo${photoCount === 1 ? "" : "s"} linked to ${componentLabel(c)}.`
                  : `At least one photo is required for condemned components. Add it under Photos & Attachments with "Linked component" set to ${componentLabel(c)}.`}
              </p>
            ) : (
              <p className="small" style={{ color: "inherit", margin: 0 }}>
                No photo needed for a condemned EGR cooler.
              </p>
            )}
          </div>
        )}
      </ActionForm>
    </div>
  );
}
