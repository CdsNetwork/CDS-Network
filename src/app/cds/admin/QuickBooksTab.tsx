import Link from "next/link";
import type { SearchOption } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import {
  removeCustomerLinkConfirm,
  removeItemLinkConfirm,
  removeMeasurementItemConfirm,
  removePartNumberConfirm,
} from "@/components/cds-admin/confirm";
import styles from "@/components/cds-admin/cds-admin.module.css";
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
  removeMeasurementMap,
  saveAlias,
  saveCustomerMap,
  saveItemMap,
  saveMeasurementMap,
} from "./qbo-actions";

type Customer = { id: string; code: string; name: string };
type Item = { id: string; sku: string; name: string };
type CustomerMap = { customer_id: string; qbo_customer_id: string; qbo_display_name: string };
type ItemMap = { id: string; customer_id: string | null; catalog_item_id: string; qbo_item_id: string; qbo_item_name: string };
type MeasurementMap = { id: string; customer_id: string | null; component_type: string; qbo_item_id: string; qbo_item_name: string };

const COMPONENT_TYPES = ["DPF", "DOC", "SCR", "EGR"] as const;
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
  const [customersRes, itemsRes, customerMapRes, itemMapRes, measurementRes, aliasRes, lists] = await Promise.all([
    supabase.from("customers").select("id, code, name").eq("active", true).order("name"),
    supabase.from("catalog_items").select("id, sku, name").eq("active", true).order("sku"),
    supabase.from("qbo_customer_map").select("customer_id, qbo_customer_id, qbo_display_name"),
    supabase.from("qbo_item_map").select("id, customer_id, catalog_item_id, qbo_item_id, qbo_item_name"),
    supabase.from("qbo_measurement_map").select("id, customer_id, component_type, qbo_item_id, qbo_item_name"),
    supabase
      .from("customer_item_aliases")
      .select("id, customer_part_number, customers(code, name), catalog_items(sku, name)")
      .order("customer_part_number"),
    qboLists(status.connected),
  ]);
  const loadError = [customersRes, itemsRes, customerMapRes, itemMapRes, measurementRes, aliasRes].some((r) => r.error);
  const customers = (customersRes.data ?? []) as Customer[];
  const items = (itemsRes.data ?? []) as Item[];
  const customerMap = new Map(((customerMapRes.data ?? []) as CustomerMap[]).map((m) => [m.customer_id, m]));
  const itemRows = (itemMapRes.data ?? []) as ItemMap[];
  // Mappings for all customers, by catalog item.
  const itemMap = new Map(itemRows.filter((m) => m.customer_id === null).map((m) => [m.catalog_item_id, m]));
  // Catalog items with at least one customer-specific mapping.
  const customerItemCount = new Map<string, number>();
  for (const m of itemRows) {
    if (m.customer_id) customerItemCount.set(m.catalog_item_id, (customerItemCount.get(m.catalog_item_id) ?? 0) + 1);
  }
  const measurementRows = (measurementRes.data ?? []) as MeasurementMap[];
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const aliases = (aliasRes.data ?? []) as Alias[];

  const customerOptions: SearchOption[] = customers.map((c) => ({
    value: c.id,
    label: `${c.code} - ${c.name}`,
    hint: customerMap.get(c.id) ? `QuickBooks: ${customerMap.get(c.id)!.qbo_display_name}` : "Not linked",
  }));
  const itemOptions: SearchOption[] = items.map((i) => {
    const forAll = itemMap.get(i.id);
    const perCustomer = customerItemCount.get(i.id) ?? 0;
    return {
      value: i.id,
      label: `${i.sku} - ${i.name}`,
      hint: [
        forAll ? `QuickBooks: ${forAll.qbo_item_name}` : perCustomer ? null : "Not linked",
        perCustomer ? `${perCustomer} customer-specific` : null,
      ]
        .filter(Boolean)
        .join(" - "),
    };
  });
  // "All customers" first: the mapping every customer without its own row uses.
  const mappingCustomerOptions: SearchOption[] = [
    { value: "", label: "All customers", hint: "Used unless the customer has its own mapping" },
    ...customers.map((c) => ({ value: c.id, label: `${c.code} - ${c.name}` })),
  ];
  const customerLabel = (id: string) => {
    const c = customerById.get(id);
    return c ? `${c.code} ${c.name}` : "Inactive customer";
  };
  // Customer-specific item rows, grouped by customer (sorted by customer name, then SKU).
  const customerItemGroups = groupByCustomer(
    itemRows.filter((m): m is ItemMap & { customer_id: string } => m.customer_id !== null),
    customerLabel,
    (m) => itemById.get(m.catalog_item_id)?.sku ?? "",
  );
  const measurementGroups = [
    ...(measurementRows.some((m) => m.customer_id === null)
      ? [{ key: "all", label: "All customers", rows: sortByType(measurementRows.filter((m) => m.customer_id === null)) }]
      : []),
    ...groupByCustomer(
      measurementRows.filter((m): m is MeasurementMap & { customer_id: string } => m.customer_id !== null),
      customerLabel,
      (m) => String(COMPONENT_TYPES.indexOf(m.component_type as (typeof COMPONENT_TYPES)[number])),
    ),
  ];
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

  const unmappedItems = items.filter((i) => !itemMap.has(i.id) && !customerItemCount.has(i.id));
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
            <QboPicker kind="customer" idPrefix="qmap-customer" options={qboCustomerOptions} />
          </div>
        </ActionForm>
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table className={styles.cardTable}>
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
                    <td className={wrapCell(c.name)} data-label="Customer">
                      <b>{c.code}</b> {c.name}
                    </td>
                    <td data-label="QuickBooks customer">
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
                          confirmText={removeCustomerLinkConfirm(`${c.code} ${c.name}`, m.qbo_display_name)}
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
        <p className="small">
          Services are often separate QuickBooks items per customer (for example &quot;EVACUFLUSH AND BAKE DPF - RYDER&quot;).
          Link a catalog item for one customer to use that customer&apos;s QuickBooks item; customers without their own link use
          the link for all customers.
        </p>
        <ActionForm action={saveItemMap} submitLabel="Link item" resetOnSuccess>
          <div className="grid3">
            <div className="field">
              <label htmlFor="qmap-item">
                Catalog item <span className="req">*</span>
              </label>
              <FormSearchSelect id="qmap-item" name="catalog_item_id" options={itemOptions} required placeholder="Type SKU or name" limit={150} />
            </div>
            <div className="field">
              <label htmlFor="qmap-item-customer">Customer</label>
              <FormSearchSelect id="qmap-item-customer" name="customer_id" options={mappingCustomerOptions} placeholder="All customers" />
            </div>
            <QboPicker kind="item" idPrefix="qmap-item" options={qboItemOptions} />
          </div>
        </ActionForm>
        <h4 style={{ marginTop: 16 }}>All customers</h4>
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table className={styles.cardTable}>
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
                    No items linked for all customers yet.
                  </td>
                </tr>
              )}
              {items
                .filter((i) => itemMap.has(i.id))
                .map((i) => {
                  const m = itemMap.get(i.id)!;
                  return (
                    <tr key={m.id}>
                      <td className={wrapCell(i.name)} data-label="Catalog item">
                        <b>{i.sku}</b> {i.name}
                      </td>
                      <td data-label="QuickBooks item">
                        {m.qbo_item_name} <span className="small">(id {m.qbo_item_id})</span>
                      </td>
                      <td>
                        <ActionForm
                          action={removeItemMap.bind(null, m.id)}
                          submitLabel="Remove"
                          confirmText={removeItemLinkConfirm(`${i.sku} ${i.name}`, "All customers", m.qbo_item_name)}
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
        {customerItemGroups.map((g) => (
          <div key={g.key}>
            <h4 style={{ marginTop: 16 }}>{g.label}</h4>
            <div className="tablewrap" style={{ marginTop: 8 }}>
              <table className={styles.cardTable}>
                <thead>
                  <tr>
                    <th>Catalog item</th>
                    <th>QuickBooks item</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((m) => {
                    const i = itemById.get(m.catalog_item_id);
                    return (
                      <tr key={m.id}>
                        <td className={wrapCell(i?.name)} data-label="Catalog item">
                          {i ? (
                            <>
                              <b>{i.sku}</b> {i.name}
                            </>
                          ) : (
                            <span className="small">Inactive catalog item</span>
                          )}
                        </td>
                        <td data-label="QuickBooks item">
                          {m.qbo_item_name} <span className="small">(id {m.qbo_item_id})</span>
                        </td>
                        <td>
                          <ActionForm
                            action={removeItemMap.bind(null, m.id)}
                            submitLabel="Remove"
                            confirmText={removeItemLinkConfirm(i ? `${i.sku} ${i.name}` : "(inactive)", g.label, m.qbo_item_name)}
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
        ))}
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

      {/* ---------------------------------------------------------- measurement lines */}
      <div className="section">
        <h3>Measurement lines</h3>
        <p className="small">
          Each component on the work order is added to the invoice as a $0 line with its readings (manufacturer, part and
          serial number, pressures, weights, result), using the QuickBooks measurement item for the customer and component type
          (for example &quot;DPF MEASUREMENTS &amp; INFO-RYDER&quot;), else the one for all customers. Without one, the line is
          left off and the invoice can still be created.
        </p>
        <ActionForm action={saveMeasurementMap} submitLabel="Save measurement item" resetOnSuccess>
          <div className="grid3">
            <div className="field">
              <label htmlFor="qmeas-customer">Customer</label>
              <FormSearchSelect id="qmeas-customer" name="customer_id" options={mappingCustomerOptions} placeholder="All customers" />
            </div>
            <div className="field">
              <label htmlFor="qmeas-type">
                Component type <span className="req">*</span>
              </label>
              <select id="qmeas-type" name="component_type" className="input" required defaultValue="">
                <option value="" disabled>
                  Choose
                </option>
                {COMPONENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <QboPicker kind="item" idPrefix="qmeas" options={qboItemOptions} />
          </div>
        </ActionForm>
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table className={styles.cardTable}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Component type</th>
                <th>QuickBooks item</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {measurementGroups.length === 0 && (
                <tr>
                  <td colSpan={4} className="small">
                    No measurement items yet: invoices have no measurement lines.
                  </td>
                </tr>
              )}
              {measurementGroups.flatMap((g) =>
                g.rows.map((m, n) => (
                  <tr key={m.id}>
                    <td data-label="Customer">
                      <b className={n === 0 ? undefined : styles.phoneOnly}>{g.label}</b>
                    </td>
                    <td data-label="Component type">{m.component_type}</td>
                    <td className={wrapCell(m.qbo_item_name)} data-label="QuickBooks item">
                      {m.qbo_item_name} <span className="small">(id {m.qbo_item_id})</span>
                    </td>
                    <td>
                      <ActionForm
                        action={removeMeasurementMap.bind(null, m.id)}
                        submitLabel="Remove"
                        confirmText={removeMeasurementItemConfirm(g.label, m.component_type)}
                        pendingLabel="..."
                        submitClassName="btn btn-secondary btn-small"
                      />
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
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
          <table className={styles.cardTable}>
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
                    <td data-label="Customer">
                      <b>{c?.code}</b> {c?.name}
                    </td>
                    <td className={wrapCell(i?.name)} data-label="Catalog item">
                      <b>{i?.sku}</b> {i?.name}
                    </td>
                    <td className={wrapCell(a.customer_part_number)} data-label="Customer part number">
                      {a.customer_part_number}
                    </td>
                    <td>
                      <ActionForm
                        action={removeAlias.bind(null, a.id)}
                        submitLabel="Remove"
                        confirmText={removePartNumberConfirm(
                          `${c?.code ?? ""} ${c?.name ?? ""}`.trim(),
                          `${i?.sku ?? ""} ${i?.name ?? ""}`.trim(),
                          a.customer_part_number,
                        )}
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

/** Rows of customer-specific mappings grouped by customer, groups sorted by customer label. */
function groupByCustomer<T extends { customer_id: string }>(
  rows: T[],
  label: (customerId: string) => string,
  sortKey: (row: T) => string,
): { key: string; label: string; rows: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.customer_id, [...(groups.get(r.customer_id) ?? []), r]);
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: label(key), rows: list.sort((a, b) => sortKey(a).localeCompare(sortKey(b))) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function sortByType<T extends { component_type: string }>(rows: T[]): T[] {
  const order = (t: string) => COMPONENT_TYPES.indexOf(t as (typeof COMPONENT_TYPES)[number]);
  return [...rows].sort((a, b) => order(a.component_type) - order(b.component_type));
}

/**
 * The QuickBooks record: a list from QuickBooks when connected, else id and name typed in.
 * idPrefix keeps element ids unique when two forms on the tab pick a QuickBooks item.
 */
function QboPicker({ kind, idPrefix, options }: { kind: "customer" | "item"; idPrefix: string; options: SearchOption[] | null }) {
  const field = kind === "customer" ? "qbo_customer" : "qbo_item";
  const label = kind === "customer" ? "QuickBooks customer" : "QuickBooks item";
  if (options) {
    return (
      <div className="field">
        <label htmlFor={`${idPrefix}-${field}-pick`}>
          {label} <span className="req">*</span>
        </label>
        <FormSearchSelect
          id={`${idPrefix}-${field}-pick`}
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
        <label htmlFor={`${idPrefix}-${field}-id`}>
          {label} id <span className="req">*</span>
        </label>
        <input id={`${idPrefix}-${field}-id`} name={`${field}_id`} className="input" required inputMode="numeric" pattern="[0-9]+" maxLength={50} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-${field}-name`}>
          {kind === "customer" ? "Display name" : "Item name"} <span className="req">*</span>
        </label>
        <input id={`${idPrefix}-${field}-name`} name={`${field}_name`} className="input" required maxLength={500} />
      </div>
    </div>
  );
}
