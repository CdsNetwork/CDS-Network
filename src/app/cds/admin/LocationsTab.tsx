import Link from "next/link";
import { SearchSelect, type SearchOption } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import styles from "@/components/cds-admin/cds-admin.module.css";
import { Pager } from "@/components/cds-admin/Pager";
import { one } from "@/components/cds-admin/server-utils";
import { FULFILLMENT_LABEL, wrapCell } from "@/lib/format";
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
type CustomerRow = { id: string; code: string; name: string };
type ShopRow = { id: string; short_code: string; display_name: string; active: boolean; city: string | null; region: string | null };

export type LocationFilters = { q: string; customer: string; shop: string; fulfillment: string; page: number };

const PAGE_SIZE = 50;
const COLUMNS =
  "id, customer_id, code, location_number, name, address_raw, address_line1, city, region, postal_code, default_affiliate_id, fulfillment, dock_note, routing_notes, active, customers(name), affiliates(display_name, short_code)";
/** Location columns the search box looks in (customer and shop names are matched separately). */
const SEARCH_COLUMNS = ["code", "location_number", "name", "address_raw", "address_line1", "city", "region", "postal_code"];

/** Search words, without characters that have a meaning in a PostgREST filter. */
function searchWords(q: string): string[] {
  return q
    .replace(/[",()*%\\]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
}

function href(f: LocationFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ tab: "locations" });
  if (f.q) params.set("q", f.q);
  if (f.customer) params.set("customer", f.customer);
  if (f.shop) params.set("shop", f.shop);
  if (f.fulfillment) params.set("fulfillment", f.fulfillment);
  if (f.page > 1) params.set("page", String(f.page));
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `/cds/admin?${params.toString()}`;
}

export async function LocationsTab({ edit, filters }: { edit?: string; filters: LocationFilters }) {
  const f = filters;
  const supabase = await createClient();
  const [{ data: custData }, { data: shopData }] = await Promise.all([
    supabase.from("customers").select("id, code, name").order("name"),
    supabase.from("affiliates").select("id, short_code, display_name, active, city, region").order("display_name"),
  ]);
  const customerRows = (custData ?? []) as CustomerRow[];
  const shopRows = (shopData ?? []) as ShopRow[];
  const customers: SearchOption[] = customerRows.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }));
  const shops: SearchOption[] = shopRows.map((s) => ({
    value: s.id,
    label: `${s.display_name} (${s.short_code})${s.active ? "" : ", inactive"}`,
    hint: [s.city, s.region].filter(Boolean).join(", ") || undefined,
  }));

  let query = supabase.from("customer_locations").select(COLUMNS, { count: "exact" });
  if (f.customer) query = query.eq("customer_id", f.customer);
  if (f.shop === "none") query = query.is("default_affiliate_id", null);
  else if (f.shop) query = query.eq("default_affiliate_id", f.shop);
  if (f.fulfillment) query = query.eq("fulfillment", f.fulfillment);
  // Every word must match a location column, the customer or the default shop.
  for (const word of searchWords(f.q)) {
    const w = word.toLowerCase();
    const or = SEARCH_COLUMNS.map((c) => `${c}.ilike."*${word}*"`);
    const customerIds = customerRows.filter((c) => `${c.name} ${c.code}`.toLowerCase().includes(w)).map((c) => c.id);
    const shopIds = shopRows.filter((s) => `${s.display_name} ${s.short_code}`.toLowerCase().includes(w)).map((s) => s.id);
    if (customerIds.length) or.push(`customer_id.in.(${customerIds.join(",")})`);
    if (shopIds.length) or.push(`default_affiliate_id.in.(${shopIds.join(",")})`);
    query = query.or(or.join(","));
  }
  const from = (f.page - 1) * PAGE_SIZE;
  const [{ data: locData, error, count }, { data: editData }] = await Promise.all([
    query.order("code").order("id").range(from, from + PAGE_SIZE - 1),
    edit && edit !== "new"
      ? supabase.from("customer_locations").select(COLUMNS).eq("id", edit).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const shown = (locData ?? []) as Location[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const editing = (editData ?? undefined) as Location | undefined;
  const filtered = Boolean(f.q || f.customer || f.shop || f.fulfillment);
  const backHref = href(f);

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

      <form className={styles.filters} method="get" action="/cds/admin">
        <input type="hidden" name="tab" value="locations" />
        <div className={styles.grow}>
          <label htmlFor="loc-q">Search</label>
          <input
            className="input"
            id="loc-q"
            type="search"
            name="q"
            defaultValue={f.q}
            placeholder="Code, number, name, address, city, ZIP or shop"
          />
        </div>
        <div className={styles.fixed}>
          <label htmlFor="loc-customer">Customer</label>
          <SearchSelect
            key={`c-${f.customer}`}
            id="loc-customer"
            name="customer"
            defaultValue={f.customer}
            placeholder="All customers"
            options={[{ value: "", label: "All customers" }, ...customers]}
          />
        </div>
        <div className={styles.fixed}>
          <label htmlFor="loc-shop">Default shop</label>
          <SearchSelect
            key={`s-${f.shop}`}
            id="loc-shop"
            name="shop"
            defaultValue={f.shop}
            placeholder="Any shop"
            options={[{ value: "", label: "Any shop" }, { value: "none", label: "No default shop" }, ...shops]}
          />
        </div>
        <div className={styles.fixed}>
          <label htmlFor="loc-fulfillment">Fulfillment</label>
          <select id="loc-fulfillment" name="fulfillment" defaultValue={f.fulfillment}>
            <option value="">Any fulfillment</option>
            {Object.entries(FULFILLMENT_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.filterActions}>
          <button className="btn btn-secondary" type="submit">
            Search
          </button>
          {filtered && (
            <Link className="link small" href="/cds/admin?tab=locations">
              Clear
            </Link>
          )}
        </div>
      </form>

      <p className="small" role="status">
        {total === 0
          ? filtered
            ? "No locations match."
            : "No locations yet."
          : `Showing ${from + 1} to ${Math.min(from + shown.length, total)} of ${total} ${filtered ? "matching " : ""}locations`}
      </p>

      {error && <div className="notice danger">Could not load locations. Refresh the page to try again.</div>}

      <div className="tablewrap">
        <table className={`wide ${styles.cardTable}`}>
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
                  {total > 0 ? (
                    <>
                      This page is empty. <Link className="link" href={href({ ...f, page: 1 })}>Go to the first page</Link>
                    </>
                  ) : filtered ? (
                    "No locations match this search."
                  ) : (
                    "No locations yet."
                  )}
                </td>
              </tr>
            )}
            {shown.map((l) => (
              <tr key={l.id} style={l.active ? undefined : { opacity: 0.6 }}>
                <td data-label="Customer">{one(l.customers)?.name ?? "-"}</td>
                <td className="nowrap">
                  <b>{l.code}</b>
                  {l.location_number && <span className="small"> #{l.location_number}</span>}
                </td>
                <td className={wrapCell(l.name)}>{l.name}</td>
                <td className={wrapCell(l.address_raw, l.routing_notes)}>
                  {l.address_raw}
                  {l.routing_notes && <div className="small">{l.routing_notes}</div>}
                </td>
                <td data-label="Default shop">{one(l.affiliates)?.display_name ?? <span className="small">Not set</span>}</td>
                <td data-label="Fulfillment">{FULFILLMENT_LABEL[l.fulfillment] ?? l.fulfillment}</td>
                <td>{l.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}</td>
                <td>
                  <Link className="link small" href={href(f, { edit: l.id })}>
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager page={f.page} pages={pages} href={(page) => href({ ...f, page })} label="Location pages" />
    </>
  );
}

function LocationFields({ loc, customers, shops }: { loc?: Location; customers: SearchOption[]; shops: SearchOption[] }) {
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
          <SearchSelect
            id={`customer-${k}`}
            name="customer_id"
            required
            defaultValue={loc?.customer_id ?? ""}
            placeholder="Type a customer name or code"
            options={customers}
          />
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
          <SearchSelect
            id={`shop-${k}`}
            name="default_affiliate_id"
            defaultValue={loc?.default_affiliate_id ?? ""}
            placeholder="Type a shop name, code or city"
            options={[{ value: "", label: "None" }, ...shops]}
          />
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
