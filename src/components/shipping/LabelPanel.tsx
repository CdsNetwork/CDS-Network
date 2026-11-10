"use client";

import { useState, useTransition } from "react";
import { createShipmentLabel, getShipmentRates, voidShipmentLabel } from "@/app/cds/shipping/label-actions";
import type { RatesResult } from "@/lib/shipstation/labels";
import { packageFormValues, packageSummary, type PackageForm, type ShipmentPackage } from "@/lib/shipstation/package";
import { voidLabelConfirm } from "./confirm";
import { PickupPanel, type PickupView } from "./PickupPanel";
import { TestBadge } from "./TestBadge";

export type LabelView = {
  id: string;
  carrier: string;
  service_name: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  is_test: boolean;
  /** CDS only. */
  cost: number | null;
  /** CDS only: the carrier pickup booked for this label. */
  pickup?: PickupView | null;
  /** CDS only: why no pickup can be booked (test labels), or null. */
  pickupRefusal?: string | null;
};

type Rates = Extract<RatesResult, { ok: true }>;

const EMPTY_PACKAGE: PackageForm = { weightLb: "", lengthIn: "", widthIn: "", heightIn: "" };

const SIDES: [keyof PackageForm, string][] = [
  ["lengthIn", "Length"],
  ["widthIn", "Width"],
  ["heightIn", "Height"],
];

const money = (n: number, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

/**
 * CDS: get live rates for a shipment leg, pick a service, create the label (a test label
 * while SHIPSTATION_TEST_LABELS is on), download or void it. pkg is the package to prefill:
 * the one saved on the shipment, else the Shipping settings default. Get rates saves the
 * package typed here on the shipment, and the label is bought for it.
 */
export function LabelPanel({
  shipmentId,
  woId,
  label,
  configured,
  pkg,
}: {
  shipmentId: string;
  woId: string;
  label: LabelView | null;
  configured: boolean;
  pkg?: ShipmentPackage | null;
}) {
  const [form, setForm] = useState<PackageForm>(() => (pkg ? packageFormValues(pkg) : EMPTY_PACKAGE));
  // The saved package changed on the server (for example in the Shipping form): show it.
  const pkgKey = pkg ? packageSummary(pkg) : "";
  const [shownPkg, setShownPkg] = useState(pkgKey);
  if (shownPkg !== pkgKey) {
    setShownPkg(pkgKey);
    setForm(pkg ? packageFormValues(pkg) : EMPTY_PACKAGE);
  }
  const [rates, setRates] = useState<Rates | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!configured) {
    return <p className="small">ShipStation is not configured on this server (SHIPSTATION_API_KEY).</p>;
  }

  if (label) {
    return (
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {label.is_test && <TestBadge />}
        <span className="small">
          <b>{label.carrier}</b> {label.service_name ?? ""}
          {label.tracking_number ? ` • ${label.tracking_number}` : ""}
          {label.cost != null && !label.is_test ? ` • cost ${money(label.cost)}` : ""}
        </span>
        <a className="btn btn-secondary btn-small" href={`/api/shipstation/label/${label.id}`} target="_blank" rel="noreferrer">
          Download label PDF
        </a>
        {label.tracking_url && !label.is_test && (
          <a className="link small" href={label.tracking_url} target="_blank" rel="noreferrer">
            Track
          </a>
        )}
        <button
          className="btn btn-danger btn-small"
          type="button"
          disabled={pending || !!label.pickup}
          title={label.pickup ? "Cancel the carrier pickup before voiding the label." : undefined}
          onClick={() => {
            if (!window.confirm(voidLabelConfirm(label))) return;
            setError(null);
            start(async () => {
              const r = await voidShipmentLabel(label.id, woId);
              if (r.ok) setMessage(r.message);
              else setError(r.error);
            });
          }}
        >
          {pending ? "Voiding..." : "Void label"}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
        {message && <p className="small" role="status">{message}</p>}
        {label.pickup !== undefined && (
          <div style={{ flexBasis: "100%" }}>
            <PickupPanel labelId={label.id} woId={woId} pickup={label.pickup} refusal={label.pickupRefusal ?? null} />
          </div>
        )}
      </div>
    );
  }

  const chosen = rates?.rates.find((r) => r.rateId === picked) ?? null;
  // Rates are for the package they were quoted with: a change needs new rates.
  const edit = (key: keyof PackageForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setRates(null);
    setPicked(null);
  };
  const sizeInput = { className: "input", type: "number", min: "0", step: "0.1", disabled: pending, style: { width: 64, padding: "5px 6px" } } as const;

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label className="small row" style={{ gap: 4, alignItems: "center", flexWrap: "nowrap" }}>
          Weight (lb)
          <input {...sizeInput} value={form.weightLb} onChange={(e) => edit("weightLb", e.target.value)} />
        </label>
        <span className="small row" style={{ gap: 4, alignItems: "center", flexWrap: "nowrap" }}>
          Box (in)
          {SIDES.map(([key, name]) => (
            <input key={key} {...sizeInput} aria-label={`${name} (in)`} placeholder={name} value={form[key]} onChange={(e) => edit(key, e.target.value)} />
          ))}
        </span>
        <button
          className="btn btn-secondary btn-small"
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setMessage(null);
            setPicked(null);
            start(async () => {
              const r = await getShipmentRates(shipmentId, form);
              if (r.ok) setRates(r);
              else {
                setRates(null);
                setError(r.error);
              }
            });
          }}
        >
          {pending && !rates ? "Getting rates..." : rates ? "Refresh rates" : "Get rates"}
        </button>
        {rates && (
          <button
            className="btn btn-primary btn-small"
            type="button"
            disabled={pending || !chosen}
            onClick={() => {
              if (!chosen) return;
              if (!rates.testLabels && !window.confirm(`Buy a real ${chosen.serviceName} label for ${money(chosen.total, chosen.currency)}?`)) return;
              setError(null);
              start(async () => {
                const r = await createShipmentLabel(shipmentId, woId, {
                  carrierId: chosen.carrierId,
                  serviceCode: chosen.serviceCode,
                  rateId: chosen.rateId,
                  quotedTotal: chosen.total,
                  deliveryDays: chosen.deliveryDays,
                });
                if (r.ok) {
                  setMessage(r.message);
                  setRates(null);
                } else setError(r.error);
              });
            }}
          >
            {pending && rates ? "Working..." : rates.testLabels ? "Create test label" : "Create label"}
          </button>
        )}
      </div>
      {rates && (
        <div style={{ marginTop: 8 }}>
          {rates.testLabels && (
            <div className="notice warning" style={{ margin: "6px 0" }}>
              Test mode: labels are not shippable and cost nothing. FedEx refuses test labels; UPS (WWEX) and USPS accept them.
            </div>
          )}
          <div className="small">
            From {rates.from}
            <br />
            To {rates.to}
            <br />
            Package {packageSummary(rates.pkg)}
          </div>
          {rates.rates.length === 0 ? (
            <p className="small">No rates for this shipment.</p>
          ) : (
            <table style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th></th>
                  <th>Service</th>
                  <th>Days</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rates.rates.map((r) => (
                  <tr key={r.rateId}>
                    <td>
                      <input
                        type="radio"
                        name={`rate-${shipmentId}`}
                        aria-label={`${r.carrierName} ${r.serviceName}`}
                        checked={picked === r.rateId}
                        onChange={() => setPicked(r.rateId)}
                        style={{ width: "auto" }}
                      />
                    </td>
                    <td>
                      {r.serviceName}
                      <div className="small">{r.carrierName}</div>
                      {r.warnings.map((w) => (
                        <div key={w} className="small">
                          {w}
                        </div>
                      ))}
                    </td>
                    <td>{r.deliveryDays ?? "-"}</td>
                    <td className="num">{money(r.total, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rates.problems.length > 0 && <div className="small">Not offered: {rates.problems.join("; ")}</div>}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="small" role="status" style={{ color: "#3b6d12", fontWeight: 700 }}>{message}</p>}
    </div>
  );
}
