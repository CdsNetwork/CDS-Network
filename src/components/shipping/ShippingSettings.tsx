import Link from "next/link";
import { addCarrier, addService, saveShippingSettings, setCarrierActive, setServiceActive } from "@/app/cds/shipping/settings-actions";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { shipStationConfig } from "@/lib/shipstation/config";
import { createClient } from "@/lib/supabase/server";

type Settings = Record<string, string | number | null>;
type Carrier = {
  id: string;
  shipstation_carrier_id: string;
  carrier: string;
  name: string;
  active: boolean;
  notes: string | null;
  shipping_services: { id: string; service_code: string; name: string; active: boolean }[] | null;
};

const FIELDS: [name: string, label: string][] = [
  ["from_company", "Company"],
  ["from_name", "Contact name"],
  ["from_phone", "Phone (also used for locations and shops)"],
  ["from_email", "Email"],
  ["address_line1", "Street"],
  ["address_line2", "Street line 2"],
  ["city", "City"],
  ["region", "State"],
  ["postal_code", "ZIP"],
  ["country", "Country"],
];

/** CDS only (rendered on the CDS shipping page): ship-from address, default package, carriers and services. */
export async function ShippingSettings() {
  const supabase = await createClient();
  const [{ data: settingsRow }, { data: carrierRows }] = await Promise.all([
    supabase.from("shipping_settings").select("*").maybeSingle(),
    supabase
      .from("shipping_carriers")
      .select("id, shipstation_carrier_id, carrier, name, active, notes, shipping_services(id, service_code, name, active)")
      .order("sort_order"),
  ]);
  const s = (settingsRow ?? {}) as Settings;
  const carriers = (carrierRows ?? []) as Carrier[];
  const config = shipStationConfig();

  return (
    <div className="section" id="settings">
      <div className="row between">
        <h3>Shipping settings</h3>
        <Link className="btn btn-secondary btn-small" href="/cds/shipping">
          Close
        </Link>
      </div>
      <div className={config ? (config.testLabels ? "notice warning" : "notice") : "notice danger"}>
        {!config
          ? "ShipStation is not configured on this server (SHIPSTATION_API_KEY)."
          : config.testLabels
            ? "Test labels are on (SHIPSTATION_TEST_LABELS): labels are not shippable and cost nothing. FedEx and UPS refuse test labels; USPS accepts them."
            : "Real labels: every label created is charged to the carrier account."}
      </div>

      <h3 style={{ marginTop: 12 }}>CDS ship-from address and default package</h3>
      <ActionForm action={saveShippingSettings} submitLabel="Save settings">
        <div className="grid3">
          {FIELDS.map(([name, label]) => (
            <div className="field" key={name}>
              <label htmlFor={`ss-${name}`}>{label}</label>
              <input className="input" id={`ss-${name}`} name={name} defaultValue={String(s[name] ?? (name === "country" ? "US" : ""))} />
            </div>
          ))}
          <div className="field">
            <label htmlFor="ss-weight">Default weight (lb)</label>
            <input className="input" id="ss-weight" name="default_weight_lb" type="number" min="0.1" max="150" step="0.1" defaultValue={String(s.default_weight_lb ?? 45)} />
          </div>
          <div className="field">
            <label>Default length / width / height (in)</label>
            <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
              <input className="input" name="default_length_in" type="number" min="0" step="0.1" aria-label="Length (in)" defaultValue={String(s.default_length_in ?? "")} />
              <input className="input" name="default_width_in" type="number" min="0" step="0.1" aria-label="Width (in)" defaultValue={String(s.default_width_in ?? "")} />
              <input className="input" name="default_height_in" type="number" min="0" step="0.1" aria-label="Height (in)" defaultValue={String(s.default_height_in ?? "")} />
            </div>
          </div>
        </div>
      </ActionForm>

      <h3 style={{ marginTop: 18 }}>Carriers and services</h3>
      <p className="small">
        Rates come from the carriers that are on. A carrier with services listed offers only the services that are on. UPS by
        Worldwide Express: connect it in ShipStation, then add its carrier id (se-...) here.
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        {carriers.map((c) => (
          <div key={c.id} className="summarybox">
            <div className="row between">
              <div>
                <b>{c.name}</b> <span className="small">{c.shipstation_carrier_id} • {c.carrier}</span>
                {c.notes && <div className="small">{c.notes}</div>}
              </div>
              <ActionForm action={setCarrierActive.bind(null, c.id)} submitLabel={c.active ? "Turn off" : "Turn on"} submitClassName="btn btn-secondary btn-small" inline>
                <input type="hidden" name="active" value={c.active ? "false" : "true"} />
                <span className={c.active ? "tag green" : "tag"}>{c.active ? "On" : "Off"}</span>
              </ActionForm>
            </div>
            <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
              {(c.shipping_services ?? []).map((sv) => (
                <ActionForm key={sv.id} action={setServiceActive.bind(null, sv.id)} submitLabel={sv.active ? "Off" : "On"} submitClassName="btn btn-secondary btn-small" inline>
                  <input type="hidden" name="active" value={sv.active ? "false" : "true"} />
                  <span className="small" style={{ minWidth: 260 }}>
                    {sv.name} <span style={{ opacity: 0.7 }}>({sv.service_code})</span> {sv.active ? "" : "• off"}
                  </span>
                </ActionForm>
              ))}
              {(c.shipping_services ?? []).length === 0 && <span className="small">All services of this carrier are offered.</span>}
            </div>
            <details style={{ marginTop: 6 }}>
              <summary className="link small">Add service</summary>
              <ActionForm action={addService.bind(null, c.id)} submitLabel="Add service" submitClassName="btn btn-secondary btn-small" resetOnSuccess>
                <div className="grid3">
                  <input className="input" name="service_code" placeholder="fedex_ground" aria-label="Service code" />
                  <input className="input" name="name" placeholder="FedEx Ground" aria-label="Service name" />
                </div>
              </ActionForm>
            </details>
          </div>
        ))}
      </div>
      <details style={{ marginTop: 10 }}>
        <summary className="link">Add carrier</summary>
        <ActionForm action={addCarrier} submitLabel="Add carrier" resetOnSuccess className="summarybox">
          <div className="grid3">
            <div className="field">
              <label htmlFor="sc-id">ShipStation carrier id</label>
              <input className="input" id="sc-id" name="shipstation_carrier_id" placeholder="se-1234567" />
            </div>
            <div className="field">
              <label htmlFor="sc-carrier">Carrier</label>
              <select id="sc-carrier" name="carrier" defaultValue="UPS">
                <option value="UPS">UPS</option>
                <option value="FedEx">FedEx</option>
                <option value="USPS">USPS</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="sc-name">Name</label>
              <input className="input" id="sc-name" name="name" placeholder="UPS (Worldwide Express)" />
            </div>
          </div>
          <label className="small">
            <input type="checkbox" name="active" style={{ width: "auto" }} /> Turn on now
          </label>
        </ActionForm>
      </details>
    </div>
  );
}
