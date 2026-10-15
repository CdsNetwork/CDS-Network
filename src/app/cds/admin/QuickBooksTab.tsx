import Link from "next/link";
import type { SearchOption } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { one } from "@/components/cds-admin/server-utils";
import { FormSearchSelect } from "@/components/cds-wo/FormSearchSelect";
import { listCustomers, listItems, type QboCustomer, type QboItem } from "@/lib/qbo/api";
import { qboStatus } from "@/lib/qbo/status";
import { qboApi } from "@/lib/qbo/tokens";
import { wrapCell } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  removeAlias,
  removeCustomerMap,
  removeItemMap,
  saveAlias,
  saveCustomerMap,
  saveItemMap,
} from "./qbo-actions";

type Customer = { id: string; code: string; name: string };
type Item = { id: string; sku: string; name: string };
type CustomerMap = { customer_id: string; qbo_customer_id: string; qbo_display_name: string };
type ItemMap = { catalog_item_id: string; qbo_item_id: string; qbo_item_name: string };
type Alias = {
  id: string;
  customer_part_number: string;
  customers: { code: string; name: string } | { code: string; name: string }[] | null;
  catalog_items: { sku: string; name: string } | { sku: string; name: string }[] | null;
};

/** Loads QuickBooks customers and items when connected; null lists mean "type the id by hand". */
async function qboLists(connected: boolean): Promise<{ customers: QboCustomer[] | null; items: QboItem[] | null; error: string | null }> {
  if (!connected) return { customers: null, items: null, error: null };
  try {
    const api = await qboApi();
    const [customers, items] = await Promise.all([listCustomers(api), listItems(api)]);
    return { customers, items, error: null };
  } catch (e) {
    return {
      customers: null,
      items: null,
      error: `QuickBooks lists could not be loaded (${e instanceof Error ? e.message : "unknown error"}). Enter ids by hand or reload.`,
    };
  }
}

export async function QuickBooksTab() {
  const supabase = await createClient();
  const status = await qboStatus(supabase);
  const [customersRes, itemsRes, customerMapRes, itemMapRes, aliasRes, lists] = await Promise.all([
    supabase.from("customers").select("id, code, name").eq("active", true).order("name"),
    supabase.from("catalog_items").select("id, sku, name").eq("active", true).order("sku"),
    supabase.from("qbo_customer_map").select("customer_id, qbo_customer_id, qbo_display_name"),
    supabase.from("qbo_item_map").select("catalog_item_id, qbo_item_id, qbo_item_name"),
    supabase
      .from("customer_item_aliases")
      .select("id, customer_part_number, customers(code, name), catalog_items(sku, name)")
      .order("customer_part_number"),
    qboLists(status.connected),
  ]);
  const loadError = [customersRes, itemsRes, customerMapRes, itemMapRes, aliasRes].some((r) => r.error);
  const customers = (customersRes.data ?? []) as Customer[];
  const items = (itemsRes.data ?? []) as Item[];
  const customerMap = new Map(((customerMapRes.data ?? []) as CustomerMap[]).map((m) => [m.customer_id, m]));
  const itemMap = new Map(((itemMapRes.data ?? []) as ItemMap[]).map((m) => [m.catalog_item_id, m]));
  const aliases = (aliasRes.data ?? []) as Alias[];

  const customerOptions: SearchOption[] = customers.map((c) => ({
    value: c.id,
    label: `${c.code} - ${c.name}`,
    hint: customerMap.get(c.id) ? `QuickBooks: ${customerMap.get(c.id)!.qbo_display_name}` : "Not linked",
  }));
  const itemOptions: SearchOption[] = items.map((i) => ({
    value: i.id,
    label: `${i.sku} - ${i.name}`,
    hint: itemMap.get(i.id) ? `QuickBooks: ${itemMap.get(i.id)!.qbo_item_name}` : "Not linked",
  }));
  const qboCustomerOptions: SearchOption[] | null =
    lists.customers?.map((c) => ({
      value: `${c.Id}::${c.DisplayName}`,
      label: c.DisplayName,
      hint: `QuickBooks id ${c.Id}${c.CompanyName && c.CompanyName !== c.DisplayName ? ` - ${c.CompanyName}` : ""}`,
    })) ?? null;
  const qboItemOptions: SearchOption[] | null =
    lists.items?.map((i) => ({
      value: `${i.Id}::${i.Name}`,
      label: i.FullyQualifiedName ?? i.Name,
      hint: [`QuickBooks id ${i.Id}`, i.Type, i.Sku && `SKU ${i.Sku}`].filter(Boolean).join(" - "),
    })) ?? null;

  const unmappedItems = items.filter((i) => !itemMap.has(i.id));
  const unmappedCustomers = customers.filter((c) => !customerMap.has(c.id));

  return (
    <>
      <div className="section">
        <h3>QuickBooks mappings</h3>
        <p className="small">
          Every customer and every item on a work order must be linked to its QuickBooks record before the invoice can be
          created. Links point into the connected QuickBooks company; after switching companies (for example from sandbox to
          production) check them again.
        </p>
        {!status.connected && (
          <div className="notice warning">
            QuickBooks is not connected, so its lists cannot be shown. Enter the QuickBooks id and name by hand, or{" "}
            <Link className="link" href="/cds/admin?tab=settings">
              connect QuickBooks in Settings
            </Link>
            .
          </div>
        )}
        {lists.error && <div className="notice danger">{lists.error}</div>}
        {loadError && <div className="notice danger">Some mappings could not be loaded. Refresh the page to try again.</div>}
      </div>

      {/* ---------------------------------------------------------- customers */}
      <div className="section">
        <h3>Customers</h3>
        <ActionForm action={saveCustomerMap} submitLabel="Link customer" resetOnSuccess>
          <div className="grid2">
            <div className="field">
              <label htmlFor="qmap-customer">
                Portal customer <span className="req">*</span>
              </label>
              <FormSearchSelect id="qmap-customer" name="customer_id" options={customerOptions} required placeholder="Type a customer name or code" />
            </div>
            <QboPicker kind="customer" options={qboCustomerOptions} />
          </div>
        </ActionForm>
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>QuickBooks customer</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 && (
                <tr>
                  <td colSpan={3} className="small">
                    No active customers.
                  </td>
                </tr>
              )}
              {customers.map((c) => {
                const m = customerMap.get(c.id);
                return (
                  <tr key={c.id}>
                    <td className={wrapCell(c.name)}>
                      <b>{c.code}</b> {c.name}
                    </td>
                    <td>
                      {m ? (
                        <>
                          {m.qbo_display_name} <span className="small">(id {m.qbo_customer_id})</span>
                        </>
                      ) : (
                        <span className="tag">Not linked</span>
                      )}
                    </td>
                    <td>
                      {m && (
                        <ActionForm
                          action={removeCustomerMap.bind(null, c.id)}
                          submitLabel="Remove"
                          pendingLabel="..."
                          submitClassName="btn btn-secondary btn-small"
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small">
          {unmappedCustomers.length === 0 ? "Every active customer is linked." : `${unmappedCustomers.length} active customers are not linked yet.`}
        </p>
      </div>

      {/* ---------------------------------------------------------- items */}
      <div className="section">
        <h3>Items</h3>
        <ActionForm action={saveItemMap} submitLabel="Link item" resetOnSuccess>
          <div className="grid2">
            <div className="field">
              <label htmlFor="qmap-item">
                Catalog item <span className="req">*</span>
              </label>
              <FormSearchSelect id="qmap-item" name="catalog_item_id" options={itemOptions} required placeholder="Type SKU or name" limit={150} />
            </div>
            <QboPicker kind="item" options={qboItemOptions} />
          </div>
        </ActionForm>
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Catalog item</th>
                <th>QuickBooks item</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {itemMap.size === 0 && (
                <tr>
                  <td colSpan={3} className="small">
                    No items linked yet.
                  </td>
                </tr>
              )}
              {items
                .filter((i) => itemMap.has(i.id))
                .map((i) => {
                  const m = itemMap.get(i.id)!;
                  return (
                    <tr key={i.id}>
                      <td className={wrapCell(i.name)}>
                        <b>{i.sku}</b> {i.name}
                      </td>
                      <td>
                        {m.qbo_item_name} <span className="small">(id {m.qbo_item_id})</span>
                      </td>
                      <td>
                        <ActionForm
                          action={removeItemMap.bind(null, i.id)}
                          submitLabel="Remove"
                          pendingLabel="..."
                          submitClassName="btn btn-secondary btn-small"
                        />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {unmappedItems.length > 0 ? (
          <details style={{ marginTop: 10 }}>
            <summary className="small link">{unmappedItems.length} active items are not linked yet</summary>
            <p className="small" style={{ marginTop: 8 }}>
              {unmappedItems.map((i) => i.sku).join(", ")}
            </p>
          </details>
        ) : (
          <p className="small">Every active catalog item is linked.</p>
        )}
      </div>

      {/* ---------------------------------------------------------- customer part numbers */}
      <div className="section">
        <h3>Customer part numbers</h3>
        <p className="small">
          Some customers (for example First Student) need their own part number on the invoice. It is added to the line
          description in QuickBooks.
        </p>
        <ActionForm action={saveAlias} submitLabel="Save part number" resetOnSuccess>
          <div className="grid3">
            <div className="field">
              <label htmlFor="alias-customer">
                Customer <span className="req">*</span>
              </label>
              <FormSearchSelect id="alias-customer" name="customer_id" options={customerOptions} required placeholder="Type a customer" />
            </div>
            <div className="field">
              <label htmlFor="alias-item">
                Catalog item <span className="req">*</span>
              </label>
              <FormSearchSelect id="alias-item" name="catalog_item_id" options={itemOptions} required placeholder="Type SKU or name" limit={150} />
            </div>
            <div className="field">
              <label htmlFor="alias-part">
                Customer part number <span className="req">*</span>
              </label>
              <input id="alias-part" name="customer_part_number" className="input" required maxLength={100} />
            </div>
          </div>
        </ActionForm>
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Catalog item</th>
                <th>Customer part number</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {aliases.length === 0 && (
                <tr>
                  <td colSpan={4} className="small">
                    No customer part numbers yet.
                  </td>
                </tr>
              )}
              {aliases.map((a) => {
                const c = one(a.customers);
                const i = one(a.catalog_items);
                return (
                  <tr key={a.id}>
                    <td>
                      <b>{c?.code}</b> {c?.name}
                    </td>
                    <td className={wrapCell(i?.name)}>
                      <b>{i?.sku}</b> {i?.name}
                    </td>
                    <td>{a.customer_part_number}</td>
                    <td>
                      <ActionForm
                        action={removeAlias.bind(null, a.id)}
                        submitLabel="Remove"
                        pendingLabel="..."
                        submitClassName="btn btn-secondary btn-small"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** The QuickBooks record: a list from QuickBooks when connected, else id and name typed in. */
function QboPicker({ kind, options }: { kind: "customer" | "item"; options: SearchOption[] | null }) {
  const field = kind === "customer" ? "qbo_customer" : "qbo_item";
  const label = kind === "customer" ? "QuickBooks customer" : "QuickBooks item";
  if (options) {
    return (
      <div className="field">
        <label htmlFor={`${field}-pick`}>
          {label} <span className="req">*</span>
        </label>
        <FormSearchSelect
          id={`${field}-pick`}
          name={field}
          options={options}
          required
          placeholder={`Type the ${kind} name as in QuickBooks`}
          limit={150}
        />
      </div>
    );
  }
  return (
    <div className="grid2" style={{ gap: 10 }}>
      <div className="field">
        <label htmlFor={`${field}-id`}>
          {label} id <span className="req">*</span>
        </label>
        <input id={`${field}-id`} name={`${field}_id`} className="input" required inputMode="numeric" pattern="[0-9]+" maxLength={50} />
      </div>
      <div className="field">
        <label htmlFor={`${field}-name`}>
          {kind === "customer" ? "Display name" : "Item name"} <span className="req">*</span>
        </label>
        <input id={`${field}-name`} name={`${field}_name`} className="input" required maxLength={500} />
      </div>
    </div>
  );
}
