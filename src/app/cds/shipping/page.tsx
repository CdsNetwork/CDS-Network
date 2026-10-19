import Link from "next/link";
import { SearchSelect } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { LabelPanel } from "@/components/shipping/LabelPanel";
import { ShippingSettings } from "@/components/shipping/ShippingSettings";
import { activeLabels, shipStationConfigured } from "@/lib/shipstation/views";
import { one } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { DIRECTION_LABEL, SHIPMENT_STATUS_LABEL, money, woLabel, wrapCell } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { createShipment, setShipmentStatus, updateShipment } from "./actions";
import { LABEL_STATUSES, NEW_SHIPMENT_STATUS, PACKAGE_TYPES, SERVICE_LEVELS, labelStatusLabel } from "./options";

type Internal = { notes: string | null; quoted_cost: string | null; actual_cost: string | null };
type ShipmentRow = {
  id: string;
  work_order_id: string;
  direction: string;
  carrier: string | null;
  service_level: string | null;
  tracking_number: string | null;
  label_status: string;
  status: string;
  package_type: string | null;
  weight_lb: string | null;
  length_in: string | null;
  width_in: string | null;
  height_in: string | null;
  ship_from: string | null;
  ship_to: string | null;
  eta_text: string | null;
  work_orders: WoRef | WoRef[] | null;
  shipment_internal: Internal | Internal[] | null;
};
type WoRef = { wo_number: number; location_label: string; customers: { name: string } | { name: string }[] | null };
type OpenWo = WoRef & { id: string };

const IN_TRANSIT = ["picked_up", "in_transit", "out_for_delivery"];
const STATUS_TAG: Record<string, string> = { delivered: "tag green", in_transit: "tag blue", out_for_delivery: "tag blue", picked_up: "tag blue" };

export default async function ShippingPage({ searchParams }: PageProps<"/cds/shipping">) {
  await requireCds();
  const { edit, new: showNew, settings } = await searchParams;
  const supabase = await createClient();

  const [{ data: shipData, error }, { data: woData }] = await Promise.all([
    supabase
      .from("shipments")
      .select(
        "id, work_order_id, direction, carrier, service_level, tracking_number, label_status, status, package_type, weight_lb, length_in, width_in, height_in, ship_from, ship_to, eta_text, work_orders(wo_number, location_label, customers(name)), shipment_internal(notes, quoted_cost, actual_cost)",
      )
      .order("created_at", { ascending: false })
      .limit(300),
    supabase
      .from("work_orders")
      .select("id, wo_number, location_label, customers(name)")
      .not("status", "in", "(cancelled,invoiced)")
      .order("wo_number", { ascending: false })
      .limit(500),
  ]);
  const shipments = (shipData ?? []) as ShipmentRow[];
  const openWos = (woData ?? []) as OpenWo[];
  const editing = typeof edit === "string" ? shipments.find((s) => s.id === edit) : undefined;
  const labels = await activeLabels(supabase, { shipmentIds: shipments.map((s) => s.id) }, true);
  const canShip = shipStationConfigured();

  const exceptions = shipments.filter((s) => s.label_status === "needed" || s.label_status === "error").length;
  const inTransit = shipments.filter((s) => IN_TRANSIT.includes(s.status)).length;

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Shipping - US</h1>
          <p>Create and track customer → affiliate, affiliate → customer, and CDS → customer shipments.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn btn-secondary" href="/cds/shipping?settings=1#settings">
            Shipping settings
          </Link>
          <Link className="btn btn-primary" href="/cds/shipping?new=1#create">
            + Create Shipment
          </Link>
        </div>
      </div>

      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <div className="card metric">
          <div className="k">Shipment legs</div>
          <div className="v">{shipments.length}</div>
        </div>
        <div className="card metric">
          <div className="k">Label exceptions</div>
          <div className="v">{exceptions}</div>
        </div>
        <div className="card metric">
          <div className="k">In transit</div>
          <div className="v">{inTransit}</div>
        </div>
      </div>

      {error && <div className="notice danger">Could not load shipments. Refresh the page to try again.</div>}

      {settings && !editing && !showNew && <ShippingSettings />}

      {editing && (
        <div className="section" id="edit">
          <div className="row between">
            <h3>Edit shipment {woFor(editing) ? woLabel(woFor(editing)!.wo_number) : ""}</h3>
            <Link className="btn btn-secondary btn-small" href="/cds/shipping">
              Close
            </Link>
          </div>
          <ActionForm key={editing.id} action={updateShipment.bind(null, editing.id)} submitLabel="Save shipment">
            <ShipmentFields s={editing} />
          </ActionForm>
        </div>
      )}

      {showNew && !editing && (
        <div className="section" id="create">
          <div className="row between">
            <h3>Create shipment</h3>
            <Link className="btn btn-secondary btn-small" href="/cds/shipping">
              Cancel
            </Link>
          </div>
          <p className="small" style={{ marginTop: -6 }}>
            Save the leg first, then use Get rates and Create label on its row. A leg shipped outside the portal can keep a
            tracking number typed by hand.
          </p>
          <ActionForm action={createShipment} submitLabel="Save Shipment" resetOnSuccess>
            <div className="field">
              <label htmlFor="work_order_id">
                Work Order <span className="req">*</span>
              </label>
              <SearchSelect
                id="work_order_id"
                name="work_order_id"
                required
                placeholder="Type a WO number, customer or location"
                emptyText="No open work order matches"
                options={openWos.map((w) => ({
                  value: w.id,
                  label: woLabel(w.wo_number),
                  hint: `${one(w.customers)?.name ?? "Customer"} • ${w.location_label}`,
                  keywords: String(w.wo_number),
                }))}
              />
            </div>
            <ShipmentFields />
          </ActionForm>
        </div>
      )}

      <div className="tablewrap" style={{ marginTop: 18 }}>
        <table className="wide">
          <thead>
            <tr>
              <th>WO</th>
              <th>Customer</th>
              <th>Route</th>
              <th>Carrier</th>
              <th>Tracking</th>
              <th>Label</th>
              <th>ShipStation label</th>
              <th>Status</th>
              <th>Notes</th>
              <th className="num">Cost</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shipments.length === 0 && (
              <tr>
                <td colSpan={11} className="small">
                  No shipments yet.
                </td>
              </tr>
            )}
            {shipments.map((s) => {
              const wo = woFor(s);
              const internal = one(s.shipment_internal);
              const cost = internal?.actual_cost ?? internal?.quoted_cost ?? null;
              return (
                <tr key={s.id}>
                  <td className="nowrap">
                    <Link className="link" href={`/cds/work-orders/${s.work_order_id}`}>
                      {wo ? woLabel(wo.wo_number) : "Open"}
                    </Link>
                  </td>
                  <td>{wo ? (one(wo.customers)?.name ?? "-") : "-"}</td>
                  <td>
                    <b>{DIRECTION_LABEL[s.direction] ?? s.direction}</b>
                  </td>
                  <td>
                    {s.carrier ?? "-"}
                    {s.service_level && <div className="small">{s.service_level}</div>}
                  </td>
                  <td className={wrapCell(s.tracking_number, s.eta_text)}>
                    {s.tracking_number ? (
                      <b style={{ color: "var(--blue)" }}>{s.tracking_number}</b>
                    ) : (
                      <span className="small">No tracking yet</span>
                    )}
                    {s.eta_text && <div className="small">ETA {s.eta_text}</div>}
                  </td>
                  <td>
                    <span className={`tag${s.label_status === "error" || s.label_status === "needed" ? "" : " blue"}`}>
                      {labelStatusLabel(s.label_status)}
                    </span>
                  </td>
                  <td style={{ minWidth: 260 }}>
                    <LabelPanel shipmentId={s.id} woId={s.work_order_id} label={labels.get(s.id) ?? null} configured={canShip} />
                  </td>
                  <td style={{ minWidth: 200 }}>
                    <span className={STATUS_TAG[s.status] ?? "tag"}>{SHIPMENT_STATUS_LABEL[s.status] ?? s.status}</span>
                    <div style={{ marginTop: 6 }}>
                      <ActionForm
                        key={`${s.id}-${s.status}`}
                        action={setShipmentStatus.bind(null, s.id)}
                        submitLabel="Set"
                        submitClassName="btn btn-secondary btn-small"
                        inline
                      >
                        <select name="status" defaultValue={s.status} aria-label="Shipment status" style={{ padding: "5px 6px", fontSize: 12 }}>
                          {Object.entries(SHIPMENT_STATUS_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </ActionForm>
                    </div>
                  </td>
                  <td className={wrapCell(internal?.notes)}>{internal?.notes ?? <span className="small">-</span>}</td>
                  <td className="num">
                    <span className="money">{money(cost)}</span>
                    {internal?.actual_cost == null && internal?.quoted_cost != null && <div className="small">quoted</div>}
                  </td>
                  <td>
                    <Link className="link small" href={`/cds/shipping?edit=${s.id}#edit`}>
                      Edit
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row small" style={{ marginTop: 8 }}>
        Statuses of legs with a ShipStation label follow the carrier (tracking webhook). Legs without one are set by hand.
      </div>

      <div className="section">
        <h3>Shipping flows</h3>
        <div className="notice">
          Parts-only orders can ship straight from the supplier to the customer (Supplier → Customer), bypassing the service
          affiliate.
        </div>
        <h3 style={{ marginTop: 16 }}>Typical DPF shipping flow</h3>
        <div className="grid3">
          <div className="summarybox">
            <b>1. Customer → Affiliate</b>
            <p className="small">CDS sends the customer a label so the part can ship to the assigned shop.</p>
          </div>
          <div className="summarybox">
            <b>2. Affiliate performs service</b>
            <p className="small">The shop receives, cleans and tests the part, then marks it ready to ship.</p>
          </div>
          <div className="summarybox">
            <b>3. Affiliate → Customer</b>
            <p className="small">CDS provides the return label and the cleaned part ships back to the customer.</p>
          </div>
        </div>
      </div>
    </>
  );
}

function woFor(s: ShipmentRow): WoRef | null {
  return one(s.work_orders);
}

function ShipmentFields({ s }: { s?: ShipmentRow }) {
  const internal = s ? one(s.shipment_internal) : null;
  return (
    <>
      <div className="grid3">
        <div className="field">
          <label htmlFor="direction">
            Shipment Direction <span className="req">*</span>
          </label>
          <select id="direction" name="direction" defaultValue={s?.direction ?? "customer_to_affiliate"} required>
            {Object.entries(DIRECTION_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="carrier">Carrier</label>
          <select id="carrier" name="carrier" defaultValue={s ? (s.carrier ?? "") : "UPS"}>
            <option value="">Not set</option>
            <option value="UPS">UPS</option>
            <option value="FedEx">FedEx</option>
            <option value="USPS">USPS</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="service_level">Service Level</label>
          <input className="input" id="service_level" name="service_level" list="service-levels" defaultValue={s?.service_level ?? ""} placeholder="UPS Ground" />
          <datalist id="service-levels">
            {SERVICE_LEVELS.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="tracking_number">Tracking #</label>
          <input className="input" id="tracking_number" name="tracking_number" defaultValue={s?.tracking_number ?? ""} placeholder="From the carrier" />
        </div>
        <div className="field">
          <label htmlFor="label_status">Label Status</label>
          <select id="label_status" name="label_status" defaultValue={s?.label_status ?? "needed"}>
            {LABEL_STATUSES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Shipment Status</label>
          <select id="status" name="status" defaultValue={s?.status ?? NEW_SHIPMENT_STATUS}>
            {Object.entries(SHIPMENT_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="package_type">Package Type</label>
          <select id="package_type" name="package_type" defaultValue={s?.package_type ?? "dpf_box"}>
            <option value="">Not set</option>
            {PACKAGE_TYPES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="weight_lb">Weight (lb)</label>
          <input className="input" id="weight_lb" name="weight_lb" type="number" min="0" step="0.1" defaultValue={s?.weight_lb ?? ""} />
        </div>
        <div className="field">
          <label>Length / Width / Height (in)</label>
          <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
            <input className="input" name="length_in" type="number" min="0" step="0.1" aria-label="Length (in)" defaultValue={s?.length_in ?? ""} />
            <input className="input" name="width_in" type="number" min="0" step="0.1" aria-label="Width (in)" defaultValue={s?.width_in ?? ""} />
            <input className="input" name="height_in" type="number" min="0" step="0.1" aria-label="Height (in)" defaultValue={s?.height_in ?? ""} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ship_from">Ship From</label>
          <input className="input" id="ship_from" name="ship_from" defaultValue={s?.ship_from ?? ""} placeholder="Customer, affiliate or CDS address" />
        </div>
        <div className="field">
          <label htmlFor="ship_to">Ship To</label>
          <input className="input" id="ship_to" name="ship_to" defaultValue={s?.ship_to ?? ""} placeholder="Customer, affiliate or CDS address" />
        </div>
        <div className="field">
          <label htmlFor="eta_text">Service ETA</label>
          <input className="input" id="eta_text" name="eta_text" defaultValue={s?.eta_text ?? ""} placeholder="2 business days" />
        </div>
        <div className="field">
          <label htmlFor="quoted_cost">Quoted Cost</label>
          <input className="input" id="quoted_cost" name="quoted_cost" type="number" min="0" step="0.01" defaultValue={internal?.quoted_cost ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="actual_cost">Actual Cost</label>
          <input className="input" id="actual_cost" name="actual_cost" type="number" min="0" step="0.01" defaultValue={internal?.actual_cost ?? ""} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="notes">Notes (CDS only)</label>
        <textarea id="notes" name="notes" rows={2} defaultValue={internal?.notes ?? ""} placeholder="Example: return label for cleaned DPF" />
      </div>
    </>
  );
}
