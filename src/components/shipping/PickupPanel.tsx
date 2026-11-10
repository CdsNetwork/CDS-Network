"use client";

import { useState, useTransition } from "react";
import { cancelLabelPickup, scheduleLabelPickup } from "@/app/cds/shipping/label-actions";
import { MAX_PICKUP_NOTES, pickupWindowText, type PickupForm } from "@/lib/shipstation/pickup-requests";

export type PickupView = {
  id: string;
  confirmation_number: string | null;
  carrier: string;
  window_start: string;
  window_end: string;
  time_zone: string;
  notes: string | null;
};

const EMPTY: PickupForm = { date: "", readyTime: "09:00", closeTime: "17:00", notes: "" };

/**
 * CDS: book a carrier pickup for a real label in use (date, ready and close time at the
 * label's ship-from address, notes for the driver), see the confirmation, cancel it. One
 * pickup per label at a time. `refusal` (test labels) keeps the button off without asking
 * ShipStation.
 */
export function PickupPanel({ labelId, woId, pickup, refusal }: { labelId: string; woId: string; pickup: PickupView | null; refusal: string | null }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PickupForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const feedback = (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="small" role="status" style={{ color: "#3b6d12", fontWeight: 700 }}>{message}</p>}
    </>
  );

  if (pickup) {
    const when = pickupWindowText(pickup.window_start, pickup.window_end, pickup.time_zone);
    return (
      <div style={{ marginTop: 6 }}>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small">
            <b>Pickup booked:</b> {when}
            {pickup.confirmation_number ? `, confirmation ${pickup.confirmation_number}` : ", no confirmation number from the carrier"}
            {pickup.notes ? ` • ${pickup.notes}` : ""}
          </span>
          <button
            className="btn btn-secondary btn-small"
            type="button"
            disabled={pending}
            onClick={() => {
              if (!window.confirm(`Cancel the ${pickup.carrier} pickup on ${when}?`)) return;
              setError(null);
              setMessage(null);
              start(async () => {
                const r = await cancelLabelPickup(pickup.id, woId);
                if (r.ok) setMessage(r.message);
                else setError(r.error);
              });
            }}
          >
            {pending ? "Cancelling..." : "Cancel pickup"}
          </button>
        </div>
        {feedback}
      </div>
    );
  }

  if (!open) {
    return (
      <div style={{ marginTop: 6 }}>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="btn btn-secondary btn-small"
            type="button"
            disabled={!!refusal}
            onClick={() => {
              setError(null);
              setMessage(null);
              setOpen(true);
            }}
          >
            Schedule pickup
          </button>
          {refusal && <span className="small">{refusal}</span>}
        </div>
        {feedback}
      </div>
    );
  }

  const set = (key: keyof PickupForm, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const field = { className: "input", disabled: pending, style: { padding: "5px 6px" } } as const;
  const labelStyle = { gap: 4, alignItems: "center", flexWrap: "nowrap" } as const;

  return (
    <div style={{ marginTop: 6 }}>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label className="small row" style={labelStyle}>
          Date
          <input {...field} type="date" value={form.date} onChange={(e) => set("date", e.target.value)} style={{ ...field.style, width: 140 }} />
        </label>
        <label className="small row" style={labelStyle}>
          Ready
          <input {...field} type="time" value={form.readyTime} onChange={(e) => set("readyTime", e.target.value)} style={{ ...field.style, width: 110 }} />
        </label>
        <label className="small row" style={labelStyle}>
          Close
          <input {...field} type="time" value={form.closeTime} onChange={(e) => set("closeTime", e.target.value)} style={{ ...field.style, width: 110 }} />
        </label>
        <input
          {...field}
          type="text"
          aria-label="Notes for the driver"
          placeholder="Notes for the driver (optional)"
          maxLength={MAX_PICKUP_NOTES}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          style={{ ...field.style, flex: "1 1 200px", minWidth: 160 }}
        />
        <button
          className="btn btn-primary btn-small"
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setMessage(null);
            start(async () => {
              const r = await scheduleLabelPickup(labelId, woId, form);
              if (r.ok) {
                setMessage(r.message);
                setOpen(false);
                setForm(EMPTY);
              } else setError(r.error);
            });
          }}
        >
          {pending ? "Booking..." : "Book pickup"}
        </button>
        <button className="btn btn-secondary btn-small" type="button" disabled={pending} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="small">Times are local to the ship-from address on the label. The carrier comes to that address.</div>
      {feedback}
    </div>
  );
}
