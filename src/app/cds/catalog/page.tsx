import Link from "next/link";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { today } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { CATEGORY_LABEL, money } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { saveCatalogItem } from "./actions";

type Item = {
  id: string;
  sku: string;
  category: string;
  name: string;
  oe_cross: string | null;
  tax_class: string;
  shop_selectable: boolean;
  active: boolean;
};
type PriceRow = { catalog_item_id: string; amount: string | null; effective_from: string };

const TAX_CLASS_LABEL: Record<string, string> = { parts: "Parts", labor: "Labor", shipping: "Shipping", exempt: "Exempt" };

export default async function CatalogPage({ searchParams }: PageProps<"/cds/catalog">) {
  await requireCds();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const cat = typeof sp.cat === "string" && sp.cat in CATEGORY_LABEL ? sp.cat : "";
  const editId = typeof sp.edit === "string" ? sp.edit : "";

  const supabase = await createClient();
  const day = today();
  const current = `effective_to.is.null,effective_to.gt.${day}`;
  const [{ data: itemData, error }, { data: rateData }, { data: sellData }] = await Promise.all([
    supabase.from("catalog_items").select("id, sku, category, name, oe_cross, tax_class, shop_selectable, active").order("sku"),
    supabase
      .from("shop_rates")
      .select("catalog_item_id, amount, effective_from")
      .is("affiliate_id", null)
      .eq("market", "US")
      .lte("effective_from", day)
      .or(current)
      .order("effective_from", { ascending: true }),
    supabase
      .from("sell_prices")
      .select("catalog_item_id, amount, effective_from")
      .eq("market", "US")
      .lte("effective_from", day)
      .or(current)
      .order("effective_from", { ascending: true }),
  ]);
  const items = (itemData ?? []) as Item[];
  // Ascending order: the latest row in effect wins.
  const rates = new Map(((rateData ?? []) as PriceRow[]).map((r) => [r.catalog_item_id, r]));
  const sells = new Map(((sellData ?? []) as PriceRow[]).map((r) => [r.catalog_item_id, r]));

  const needle = q.toLowerCase();
  const shown = items.filter(
    (i) =>
      (!cat || i.category === cat) &&
      (!needle ||
        [i.sku, i.name, i.oe_cross ?? "", CATEGORY_LABEL[i.category] ?? ""].some((v) => v.toLowerCase().includes(needle))),
  );
  const editing = editId ? items.find((i) => i.id === editId) : undefined;

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Parts & Services - US</h1>
          <p>The master CDS catalog with what CDS pays the shop and what the fleet is charged.</p>
        </div>
        <span className="pill">
          {shown.length} of {items.length} items
        </span>
      </div>

      <div className="notice">
        Changing a price starts a new price from today and keeps the old one in history. Existing work orders keep the
        prices they were created with.
      </div>

      {editing && (
        <div className="section" id="edit">
          <div className="row between">
            <h3>Edit {editing.sku}</h3>
            <Link className="btn btn-secondary btn-small" href={backHref(q, cat)}>
              Close
            </Link>
          </div>
          <ActionForm key={editing.id} action={saveCatalogItem.bind(null, editing.id)} submitLabel="Save item">
            <ItemFields item={editing} rate={rates.get(editing.id)?.amount ?? null} sell={sells.get(editing.id)?.amount ?? null} />
          </ActionForm>
        </div>
      )}

      <details className="section">
        <summary style={{ cursor: "pointer", fontWeight: 750 }}>+ Add catalog item</summary>
        <div style={{ marginTop: 14 }}>
          <ActionForm action={saveCatalogItem.bind(null, null)} submitLabel="Add item" resetOnSuccess>
            <ItemFields />
          </ActionForm>
        </div>
      </details>

      <form className="toolbar" method="get" action="/cds/catalog">
        <input
          className="input search"
          style={{ maxWidth: 520 }}
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search CDS-G-1056, Cummins, A4709971245..."
          aria-label="Search catalog"
        />
        <select name="cat" defaultValue={cat} style={{ maxWidth: 200 }} aria-label="Category">
          <option value="">All categories</option>
          {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn btn-secondary" type="submit">
          Filter
        </button>
        {(q || cat) && (
          <Link className="link small" href="/cds/catalog">
            Clear
          </Link>
        )}
      </form>

      {error && <div className="notice danger">Could not load the catalog. Refresh the page to try again.</div>}

      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th>Description / OE Cross</th>
              <th className="num">Shop Rate</th>
              <th className="num">Fleet Price</th>
              <th className="num">Margin</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="small">
                  {items.length === 0 ? "No catalog items yet. Add the first one above." : "No items match this search."}
                </td>
              </tr>
            )}
            {shown.map((i) => {
              const rate = rates.get(i.id)?.amount ?? null;
              const sell = sells.get(i.id)?.amount ?? null;
              const margin = rate !== null && sell !== null ? Number(sell) - Number(rate) : null;
              const pct = margin !== null && Number(sell) > 0 ? Math.round((margin / Number(sell)) * 100) : null;
              return (
                <tr key={i.id} style={i.active ? undefined : { opacity: 0.6 }}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <b>{i.sku}</b>
                  </td>
                  <td>
                    <span className="tag">{CATEGORY_LABEL[i.category] ?? i.category}</span>
                  </td>
                  <td>
                    <b>{i.name}</b>
                    {i.oe_cross && <div className="small">{i.oe_cross}</div>}
                    {!i.shop_selectable && <div className="small">Not selectable by shops</div>}
                  </td>
                  <td className="num">
                    <span className="money">{money(rate)}</span>
                  </td>
                  <td className="num">
                    <span className="money">{money(sell)}</span>
                  </td>
                  <td className="num">
                    <span className="money" style={margin !== null && margin < 0 ? { color: "var(--red)" } : undefined}>
                      {money(margin)}
                    </span>
                    {pct !== null && <div className="small">{pct}%</div>}
                  </td>
                  <td>{i.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}</td>
                  <td>
                    <Link className="link small" href={`${backHref(q, cat)}${backHref(q, cat).includes("?") ? "&" : "?"}edit=${i.id}#edit`}>
                      Edit
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">
        Shop Rate is the default amount CDS pays a shop (for parts the network figure, for services the affiliate figure).
        Per-shop rates are not shown here.
      </p>
    </>
  );
}

function backHref(q: string, cat: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (cat) params.set("cat", cat);
  const s = params.toString();
  return s ? `/cds/catalog?${s}` : "/cds/catalog";
}

function ItemFields({ item, rate, sell }: { item?: Item; rate?: string | null; sell?: string | null }) {
  return (
    <>
      <div className="grid3">
        <div className="field">
          <label htmlFor={`sku-${item?.id ?? "new"}`}>
            SKU <span className="req">*</span>
          </label>
          <input className="input" id={`sku-${item?.id ?? "new"}`} name="sku" required defaultValue={item?.sku ?? ""} placeholder="CDS-G-1056" />
        </div>
        <div className="field">
          <label htmlFor={`category-${item?.id ?? "new"}`}>Category</label>
          <select id={`category-${item?.id ?? "new"}`} name="category" defaultValue={item?.category ?? "service"}>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`tax-${item?.id ?? "new"}`}>Tax Class</label>
          <select id={`tax-${item?.id ?? "new"}`} name="tax_class" defaultValue={item?.tax_class ?? "parts"}>
            {Object.entries(TAX_CLASS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`name-${item?.id ?? "new"}`}>
            Description <span className="req">*</span>
          </label>
          <input className="input" id={`name-${item?.id ?? "new"}`} name="name" required defaultValue={item?.name ?? ""} />
        </div>
        <div className="field">
          <label htmlFor={`oe-${item?.id ?? "new"}`}>OE Cross</label>
          <input className="input" id={`oe-${item?.id ?? "new"}`} name="oe_cross" defaultValue={item?.oe_cross ?? ""} placeholder="OE part numbers" />
        </div>
        <div className="field">
          <label>Flags</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 500 }}>
            <input type="checkbox" name="shop_selectable" defaultChecked={item?.shop_selectable ?? true} /> Shops can select it
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 500 }}>
            <input type="checkbox" name="active" defaultChecked={item?.active ?? true} /> Active
          </label>
        </div>
        <div className="field">
          <label htmlFor={`rate-${item?.id ?? "new"}`}>Shop Rate (USD)</label>
          <input className="input" id={`rate-${item?.id ?? "new"}`} name="shop_rate" type="number" min="0" step="0.01" defaultValue={rate ?? ""} placeholder="What CDS pays the shop" />
        </div>
        <div className="field">
          <label htmlFor={`fleet-${item?.id ?? "new"}`}>Fleet Price (USD)</label>
          <input className="input" id={`fleet-${item?.id ?? "new"}`} name="fleet_price" type="number" min="0" step="0.01" defaultValue={sell ?? ""} placeholder="Default customer price" />
        </div>
      </div>
      {item && (
        <p className="small" style={{ marginTop: 0 }}>
          Leaving a price blank ends it from today. An item without a Fleet Price cannot be added to new work orders.
        </p>
      )}
    </>
  );
}
