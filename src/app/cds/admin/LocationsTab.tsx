import Link from "next/link";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { one } from "@/components/cds-admin/server-utils";
import { FULFILLMENT_LABEL } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { saveLocation } from "./actions";

type Location = {
  id: string;
  customer_id: string;
  code: string;
  location_number: string | null;
  name: string;
  address_raw: string;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  default_affiliate_id: string | null;
  fulfillment: string;
  dock_note: string | null;
  routing_notes: string | null;
  active: boolean;
  customers: { name: string } | { name: string }[] | null;
  affiliates: { display_name: string; short_code: string } | { display_name: string; short_code: string }[] | null;
};
type Option = { id: string; label: string };

export async function LocationsTab({ edit, q }: { edit?: string; q: string }) {
  const supabase = await createClient();
  const [{ data: locData, error }, { data: custData }, { data: shopData }] = await Promise.all([
    supabase
      .from("customer_locations")
      .select(
        "id, customer_id, code, location_number, name, address_raw, address_line1, city, region, postal_code, default_affiliate_id, fulfillment, dock_note, routing_notes, active, customers(name), affiliates(display_name, short_code)",
      )
      .order("code")
      .limit(2000),
    supabase.from("customers").select("id, code, name").order("name"),
    supabase.from("affiliates").select("id, short_code, display_name, active").order("display_name"),
  ]);
  const locations = (locData ?? []) as Location[];
  const customers: Option[] = ((custData ?? []) as { id: string; code: string; name: string }[]).map((c) => ({
    id: c.id,
    label: `${c.name} (${c.code})`,
  }));
  const shops: Option[] = ((shopData ?? []) as { id: string; short_code: string; display_name: string; active: boolean }[]).map((s) => ({
    id: s.id,
    label: `${s.display_name} (${s.short_code})${s.active ? "" : " - inactive"}`,
  }));

  const needle = q.toLowerCase();
  const shown = needle
    ? locations.filter((l) =>
        [l.code, l.location_number ?? "", l.name, l.address_raw, l.city ?? "", one(l.customers)?.name ?? "", one(l.affiliates)?.display_name ?? ""].some(
          (v) => v.toLowerCase().includes(needle),
        ),
      )
    : locations;
  const editing = edit && edit !== "new" ? locations.find((l) => l.id === edit) : undefined;
  const backHref = q ? `/cds/admin?tab=locations&q=${encodeURIComponent(q)}` : "/cds/admin?tab=locations";

  return (
    <>
      {editing ? (
        <div className="section">
          <div className="row between">
            <h3>Edit {editing.code}</h3>
            <Link className="btn btn-secondary btn-small" href={backHref}>
              Close
            </Link>
          </div>
          <ActionForm key={editing.id} action={saveLocation.bind(null, editing.id)} submitLabel="Save location">
            <LocationFields loc={editing} customers={customers} shops={shops} />
          </ActionForm>
        </div>
      ) : (
        <details className="section" open={edit === "new"}>
          <summary style={{ cursor: "pointer", fontWeight: 750 }}>+ Add location</summary>
          <div style={{ marginTop: 14 }}>
            {customers.length === 0 ? (
              <p className="small">Add a customer first.</p>
            ) : (
              <ActionForm action={saveLocation.bind(null, null)} submitLabel="Add location" resetOnSuccess>
                <LocationFields customers={customers} shops={shops} />
              </ActionForm>
            )}
          </div>
        </details>
      )}

      <form className="toolbar" method="get" action="/cds/admin">
        <input type="hidden" name="tab" value="locations" />
        <input className="input search" type="search" name="q" defaultValue={q} placeholder="Search code, name, address, customer or shop" aria-label="Search locations" />
        <button className="btn btn-secondary" type="submit">
          Search
        </button>
        <span className="pill">
          {shown.length} of {locations.length} locations
        </span>
      </form>

      {error && <div className="notice danger">Could not load locations. Refresh the page to try again.</div>}

      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Code</th>
              <th>Name</th>
              <th>Address</th>
              <th>Default Shop</th>
              <th>Fulfillment</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="small">
                  {locations.length === 0 ? "No locations yet." : "No locations match this search."}
                </td>
              </tr>
            )}
            {shown.map((l) => (
              <tr key={l.id} style={l.active ? undefined : { opacity: 0.6 }}>
                <td>{one(l.customers)?.name ?? "-"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <b>{l.code}</b>
                  {l.location_number && <div className="small">#{l.location_number}</div>}
                </td>
                <td>{l.name}</td>
                <td>
                  {l.address_raw}
                  {l.routing_notes && <div className="small">{l.routing_notes}</div>}
                </td>
                <td>{one(l.affiliates)?.display_name ?? <span className="small">Not set</span>}</td>
                <td>{FULFILLMENT_LABEL[l.fulfillment] ?? l.fulfillment}</td>
                <td>{l.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}</td>
                <td>
                  <Link className="link small" href={`${backHref}&edit=${l.id}`}>
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LocationFields({ loc, customers, shops }: { loc?: Location; customers: Option[]; shops: Option[] }) {
  const k = loc?.id ?? "new";
  const input = (name: keyof Location, label: string, opts: { required?: boolean; placeholder?: string } = {}) => (
    <div className="field">
      <label htmlFor={`${name}-${k}`}>
        {label} {opts.required && <span className="req">*</span>}
      </label>
      <input
        className="input"
        id={`${name}-${k}`}
        name={name}
        required={opts.required}
        placeholder={opts.placeholder}
        defaultValue={(loc?.[name] as string | null | undefined) ?? ""}
      />
    </div>
  );
  return (
    <>
      <div className="grid3">
        <div className="field">
          <label htmlFor={`customer-${k}`}>
            Customer <span className="req">*</span>
          </label>
          <select id={`customer-${k}`} name="customer_id" required defaultValue={loc?.customer_id ?? ""}>
            <option value="" disabled>
              Choose a customer
            </option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        {input("code", "Location code", { required: true, placeholder: "DAL-04" })}
        {input("location_number", "Location number")}
        {input("name", "Name", { required: true })}
        {input("address_raw", "Full address", { required: true, placeholder: "1200 Example Rd, Dallas, TX 75201" })}
        {input("address_line1", "Street")}
        {input("city", "City")}
        <div className="grid2" style={{ gap: 10 }}>
          {input("region", "State")}
          {input("postal_code", "ZIP")}
        </div>
        <div className="field">
          <label htmlFor={`shop-${k}`}>Default shop</label>
          <select id={`shop-${k}`} name="default_affiliate_id" defaultValue={loc?.default_affiliate_id ?? ""}>
            <option value="">None</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`fulfillment-${k}`}>Fulfillment</label>
          <select id={`fulfillment-${k}`} name="fulfillment" defaultValue={loc?.fulfillment ?? "unspecified"}>
            {Object.entries(FULFILLMENT_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {input("dock_note", "Dock note")}
        <div className="field">
          <label>&nbsp;</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 500 }}>
            <input type="checkbox" name="active" defaultChecked={loc?.active ?? true} /> Active
          </label>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`routing-${k}`}>Routing notes (CDS only)</label>
        <textarea id={`routing-${k}`} name="routing_notes" rows={2} defaultValue={loc?.routing_notes ?? ""} />
      </div>
    </>
  );
}
