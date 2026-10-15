import Link from "next/link";
import { SearchSelect } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import styles from "@/components/cds-admin/cds-admin.module.css";
import { BELOW_SHOP_RATE_MESSAGE, belowShopRate } from "@/components/cds-admin/margin";
import { OverrideInput } from "@/components/cds-admin/PriceWarning";
import { one, today } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { CATEGORY_LABEL, date, money } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { setOverride } from "./actions";

type Customer = { id: string; code: string; name: string };
type Item = { id: string; sku: string; category: string; name: string; oe_cross: string | null };
type PriceRow = { id: string; catalog_item_id: string; amount: string; effective_from: string };
type AuditRow = { row_id: string; at: string; actor_name: string | null; profiles: { full_name: string } | { full_name: string }[] | null };

export default async function PricingPage({ searchParams }: PageProps<"/cds/pricing">) {
  await requireCds();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const below = sp.below === "1";
  const supabase = await createClient();
  const day = today();
  const current = `effective_to.is.null,effective_to.gt.${day}`;

  const [{ data: custData }, { data: itemData }, { data: sellData }, { data: rateData }] = await Promise.all([
    supabase.from("customers").select("id, code, name").eq("active", true).order("name"),
    supabase.from("catalog_items").select("id, sku, category, name, oe_cross").eq("active", true).order("sku"),
    supabase
      .from("sell_prices")
      .select("id, catalog_item_id, amount, effective_from")
      .eq("market", "US")
      .lte("effective_from", day)
      .or(current)
      .order("effective_from", { ascending: true }),
    supabase
      .from("shop_rates")
      .select("id, catalog_item_id, amount, effective_from")
      .is("affiliate_id", null)
      .eq("market", "US")
      .lte("effective_from", day)
      .or(current)
      .order("effective_from", { ascending: true }),
  ]);
  const customers = (custData ?? []) as Customer[];
  const items = (itemData ?? []) as Item[];
  const sells = new Map(((sellData ?? []) as PriceRow[]).map((r) => [r.catalog_item_id, r]));
  // Default shop rate (what CDS pays a shop without its own rate).
  const rates = new Map(((rateData ?? []) as PriceRow[]).map((r) => [r.catalog_item_id, r]));

  const customerId = typeof sp.customer === "string" && customers.some((c) => c.id === sp.customer) ? sp.customer : customers[0]?.id;
  const customer = customers.find((c) => c.id === customerId);

  let overrides = new Map<string, PriceRow>();
  const lastChange = new Map<string, { at: string; by: string | null }>();
  if (customer) {
    const { data } = await supabase
      .from("customer_price_overrides")
      .select("id, catalog_item_id, amount, effective_from")
      .eq("customer_id", customer.id)
      .eq("market", "US")
      .lte("effective_from", day)
      .or(current)
      .order("effective_from", { ascending: true });
    overrides = new Map(((data ?? []) as PriceRow[]).map((r) => [r.catalog_item_id, r]));

    const ids = [...overrides.values()].map((o) => o.id);
    if (ids.length > 0) {
      const { data: audit } = await supabase
        .from("audit_log")
        .select("row_id, at, actor_name, profiles(full_name)")
        .eq("table_name", "customer_price_overrides")
        .in("row_id", ids)
        .order("at", { ascending: false })
        .limit(2000);
      for (const a of (audit ?? []) as AuditRow[]) {
        if (!lastChange.has(a.row_id)) lastChange.set(a.row_id, { at: a.at, by: one(a.profiles)?.full_name ?? a.actor_name ?? null });
      }
    }
  }

  const effectiveOf = (id: string) => overrides.get(id)?.amount ?? sells.get(id)?.amount ?? null;
  const isBelow = (id: string) => belowShopRate(rates.get(id)?.amount, effectiveOf(id));
  const belowCount = customer ? items.filter((i) => isBelow(i.id)).length : 0;

  const needle = q.toLowerCase();
  const shown = items.filter(
    (i) =>
      (!below || isBelow(i.id)) &&
      (!needle || [i.sku, i.name, i.oe_cross ?? "", CATEGORY_LABEL[i.category] ?? ""].some((v) => v.toLowerCase().includes(needle))),
  );
  const hrefWith = (onlyBelow: boolean) => {
    const params = new URLSearchParams();
    if (customer) params.set("customer", customer.id);
    if (q) params.set("q", q);
    if (onlyBelow) params.set("below", "1");
    return `/cds/pricing?${params.toString()}`;
  };

  return (
    <>
      <div className="title">
        <h1>Customer Pricing - US</h1>
        <p>Fleet Price is the default. Customer overrides take priority when entered.</p>
      </div>

      <div className="section">
        <form method="get" action="/cds/pricing" className="grid3" style={{ alignItems: "end" }}>
          <div className="field">
            <label htmlFor="customer">Customer</label>
            {customers.length === 0 ? (
              <select id="customer" name="customer" defaultValue="">
                <option value="">No customers yet</option>
              </select>
            ) : (
              <SearchSelect
                key={customer?.id ?? ""}
                id="customer"
                name="customer"
                defaultValue={customer?.id ?? ""}
                placeholder="Type a customer name or code"
                options={customers.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))}
              />
            )}
          </div>
          <div className="field">
            <label htmlFor="q">Filter catalog</label>
            <input className="input" id="q" name="q" type="search" defaultValue={q} placeholder="Search service or part" />
            {below && <input type="hidden" name="below" value="1" />}
          </div>
          <div className="field">
            <button className="btn btn-secondary" type="submit">
              Show prices
            </button>
          </div>
        </form>
        <div className="notice" style={{ marginBottom: 0 }}>
          Blank override = use Fleet Price. A new override applies from today; existing work orders keep the prices they were
          created with.
        </div>
        {belowCount > 0 && (
          <div className="notice warning" style={{ marginBottom: 0 }}>
            <b>
              {belowCount} {belowCount === 1 ? "item is" : "items are"} priced below the shop rate for {customer?.name}.
            </b>{" "}
            {BELOW_SHOP_RATE_MESSAGE}.{" "}
            <Link className="link" href={hrefWith(!below)}>
              {below ? "Show all items" : "Show only these"}
            </Link>
          </div>
        )}
      </div>

      <div className="section">
        <h3>Price table</h3>
        {!customer ? (
          <p className="small">Add a customer in Admin to set customer prices.</p>
        ) : (
          <div className="tablewrap" style={{ boxShadow: "none" }}>
            <table className="wide">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Description</th>
                  <th className="num">Shop Rate</th>
                  <th className="num">Fleet Default</th>
                  <th>{customer.name} Override</th>
                  <th className="num">Effective Sell</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="small">
                      No catalog items match this filter.
                    </td>
                  </tr>
                )}
                {shown.map((i) => {
                  const fleet = sells.get(i.id)?.amount ?? null;
                  const override = overrides.get(i.id);
                  const effective = override?.amount ?? fleet;
                  const rate = rates.get(i.id)?.amount ?? null;
                  const change = override ? lastChange.get(override.id) : undefined;
                  return (
                    <tr key={i.id}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <b>{i.sku}</b>
                        <div className="small">{CATEGORY_LABEL[i.category] ?? i.category}</div>
                      </td>
                      <td>
                        {i.name}
                        {i.oe_cross && <div className="small">{i.oe_cross}</div>}
                      </td>
                      <td className="num">
                        <span className="money">{money(rate)}</span>
                      </td>
                      <td className="num">
                        <span className="money">{money(fleet)}</span>
                      </td>
                      <td style={{ minWidth: 260 }}>
                        <ActionForm key={`${customer.id}-${i.id}-${override?.amount ?? ""}`} action={setOverride.bind(null, customer.id, i.id)}>
                          <OverrideInput
                            shopRate={rate}
                            defaultValue={override?.amount ?? ""}
                            ariaLabel={`${customer.name} override for ${i.sku}`}
                          >
                            <button className="btn btn-secondary btn-small" type="submit" name="intent" value="save">
                              Save
                            </button>
                            {override && (
                              <button className="btn btn-danger btn-small" type="submit" name="intent" value="clear">
                                Clear
                              </button>
                            )}
                          </OverrideInput>
                          {override && (
                            <div className="small">
                              {change
                                ? `Last changed ${date(change.at)}${change.by ? ` by ${change.by}` : ""}`
                                : `In effect since ${override.effective_from}`}
                            </div>
                          )}
                        </ActionForm>
                      </td>
                      <td className="num">
                        <span className="money">{money(effective)}</span>
                        <div className="small">{override ? "Override" : fleet !== null ? "Fleet" : "No price"}</div>
                        {belowShopRate(rate, effective) && (
                          <span className={styles.warnTag} title={BELOW_SHOP_RATE_MESSAGE}>
                            Below shop rate
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
