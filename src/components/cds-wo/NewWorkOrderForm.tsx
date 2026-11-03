"use client";

import { startTransition, useActionState, useMemo, useState, type FormEvent } from "react";
import { CATEGORY_LABEL, FULFILLMENT_LABEL, money } from "@/lib/format";
import { SearchSelect, type SearchOption } from "@/components/SearchSelect";
import type { ActionState } from "./ActionForm";
import { LocationPicker } from "./LocationPicker";

export type LocationOption = {
  id: string;
  customer_id: string;
  code: string;
  location_number: string | null;
  name: string;
  address_raw: string;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  fulfillment: string;
  routing_notes: string | null;
  dock_note: string | null;
  shopName: string | null;
};

export type CatalogOption = {
  id: string;
  sku: string;
  name: string;
  category: string;
  oe_cross: string | null;
  fleetPrice: number | null;
};

type Props = {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  customers: { id: string; code: string; name: string }[];
  locations: LocationOption[];
  catalog: CatalogOption[];
  /** customer id -> catalog item id -> override price */
  overrides: Record<string, Record<string, number>>;
};

type Line = { catalog_item_id: string; qty: number };

export function NewWorkOrderForm({ action, customers, locations, catalog, overrides }: Props) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});

  const [customerId, setCustomerId] = useState("");
  const [requestType, setRequestType] = useState("service");
  const [fulfillment, setFulfillment] = useState("unspecified");
  const [siteAddress, setSiteAddress] = useState("");
  const [locQuery, setLocQuery] = useState("");
  const [location, setLocation] = useState<LocationOption | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [pickItem, setPickItem] = useState("");
  const [pickQty, setPickQty] = useState("1");

  const customerLocations = useMemo(() => locations.filter((l) => l.customer_id === customerId), [locations, customerId]);
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const customerOverrides = overrides[customerId] ?? {};

  function priceFor(itemId: string): { price: number | null; source: string } {
    const o = customerOverrides[itemId];
    if (o !== undefined) return { price: o, source: "Customer price" };
    return { price: catalogById.get(itemId)?.fleetPrice ?? null, source: "Fleet price" };
  }

  function chooseLocation(l: LocationOption) {
    setLocation(l);
    setLocQuery(`${l.code} - ${l.name}`);
    setSiteAddress(l.address_raw);
    if (requestType !== "parts_only") setFulfillment(l.fulfillment);
  }

  function onCustomerChange(id: string) {
    setCustomerId(id);
    setLocation(null);
    setLocQuery("");
    setSiteAddress("");
  }

  function onRequestTypeChange(value: string) {
    setRequestType(value);
    if (value === "parts_only") setFulfillment("supplier_direct");
    else if (location) setFulfillment(location.fulfillment);
  }

  function addLine() {
    const qty = Number(pickQty);
    if (!pickItem || !Number.isFinite(qty) || qty <= 0) return;
    setLines((prev) => {
      const existing = prev.find((l) => l.catalog_item_id === pickItem);
      if (existing) return prev.map((l) => (l === existing ? { ...l, qty: l.qty + qty } : l));
      return [...prev, { catalog_item_id: pickItem, qty }];
    });
    setPickItem("");
    setPickQty("1");
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => formAction(fd));
  }

  const catalogOptions: SearchOption[] = catalog.map((c) => {
    const p = customerId ? priceFor(c.id) : { price: c.fleetPrice, source: "Fleet price" };
    const price = p.price === null ? "no price" : `${money(p.price)}${customerId && p.source === "Customer price" ? " (customer price)" : ""}`;
    return {
      value: c.id,
      label: `${c.sku} - ${c.name}`,
      hint: `${CATEGORY_LABEL[c.category] ?? c.category} · ${price}`,
      keywords: c.oe_cross ?? undefined,
    };
  });

  const linesTotal = lines.reduce((sum, l) => sum + (priceFor(l.catalog_item_id).price ?? 0) * l.qty, 0);
  const missingPrice = lines.some((l) => priceFor(l.catalog_item_id).price === null);

  const fulfillmentHelper: Record<string, string> = {
    pickup: "Pickup jobs need a pickup window from the shop when it accepts.",
    shipping: "Shipping labels are added on the work order page. Label buying is Milestone 2.",
    supplier_direct: "Parts only: location routing is bypassed. The supplier ships directly to the customer.",
    unspecified: "Choose how the part moves between the customer and the shop.",
  };

  return (
    <form onSubmit={onSubmit}>
      <input type="hidden" name="location_id" value={location?.id ?? ""} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <div className="grid2">
        <section className="section">
          <h3>Customer request</h3>
          <div className="field">
            <label htmlFor="customer_id">
              Customer <span className="req">*</span>
            </label>
            <select id="customer_id" name="customer_id" required value={customerId} onChange={(e) => onCustomerChange(e.target.value)}>
              <option value="">Select customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <LocationPicker
            customerId={customerId}
            locations={customerLocations}
            location={location}
            query={locQuery}
            onQueryChange={setLocQuery}
            onChoose={chooseLocation}
            onClear={() => setLocation(null)}
          />
          <div className="field">
            <label htmlFor="request_type">
              Request Type <span className="req">*</span>
            </label>
            <select id="request_type" name="request_type" value={requestType} onChange={(e) => onRequestTypeChange(e.target.value)}>
              <option value="service">Service / Cleaning</option>
              <option value="parts_only">Parts Only</option>
            </select>
          </div>
          <div className="grid2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="unit_number">
                Unit # <span className="req">*</span>
              </label>
              <input id="unit_number" name="unit_number" className="input" required maxLength={100} />
            </div>
            <div className="field">
              <label htmlFor="po_number">PO #</label>
              <input id="po_number" name="po_number" className="input" maxLength={100} />
              <div className="small" style={{ marginTop: 5 }}>
                A missing PO is flagged on review.
              </div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="site_address">
              Customer / Ship-to address <span className="small">(tax destination)</span>
            </label>
            <input
              id="site_address"
              name="site_address"
              className="input"
              placeholder="Street, City, State, ZIP"
              maxLength={500}
              value={siteAddress}
              onChange={(e) => setSiteAddress(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="fulfillment">
              Fulfillment Method <span className="req">*</span>
            </label>
            <select id="fulfillment" name="fulfillment" value={fulfillment} onChange={(e) => setFulfillment(e.target.value)}>
              <option value="unspecified">Not set</option>
              <option value="pickup">{FULFILLMENT_LABEL.pickup}</option>
              <option value="shipping">{FULFILLMENT_LABEL.shipping}</option>
              <option value="supplier_direct">{FULFILLMENT_LABEL.supplier_direct}</option>
            </select>
            <div className="small" style={{ marginTop: 5 }}>
              {fulfillmentHelper[fulfillment]}
            </div>
          </div>
          <div className="field">
            <label htmlFor="requested_work">
              Requested work <span className="req">*</span>
            </label>
            <textarea id="requested_work" name="requested_work" rows={4} required maxLength={2000} placeholder="DPF Cleaning, clamps/gaskets..." />
          </div>
        </section>

        <section className="section">
          <h3>Services &amp; parts</h3>
          <p className="small" style={{ marginTop: 0 }}>
            Pick from the CDS catalog. Prices show the customer&apos;s own price when one is set, else the fleet price.
            Prices are fixed on the order when it is created.
          </p>
          <div className="summarybox">
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div style={{ flex: "1 1 240px" }}>
                <label className="small" htmlFor="pick_item">
                  Catalog item
                </label>
                <SearchSelect
                  id="pick_item"
                  options={catalogOptions}
                  value={pickItem}
                  onChange={(v) => setPickItem(v)}
                  placeholder="Type SKU, name or OE number..."
                  limit={150}
                />
              </div>
              <div style={{ width: 90 }}>
                <label className="small" htmlFor="pick_qty">
                  Qty
                </label>
                <input
                  id="pick_qty"
                  className="input"
                  type="number"
                  min="0.01"
                  step="any"
                  value={pickQty}
                  onChange={(e) => setPickQty(e.target.value)}
                />
              </div>
              <button type="button" className="btn btn-secondary" onClick={addLine} disabled={!pickItem}>
                + Add Item
              </button>
            </div>
          </div>
          {lines.length === 0 ? (
            <p className="small">No services or parts yet. At least one line is needed before dispatch.</p>
          ) : (
            <div className="tablewrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Customer price</th>
                    <th className="num">Line</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const item = catalogById.get(l.catalog_item_id);
                    const p = priceFor(l.catalog_item_id);
                    return (
                      <tr key={l.catalog_item_id}>
                        <td>
                          <b>{item?.sku}</b>
                          <div className="small">{item?.name}</div>
                        </td>
                        <td className="num">{l.qty}</td>
                        <td className="num">
                          <span className="money">{p.price === null ? "No price" : money(p.price)}</span>
                          <div className="small">{p.source}</div>
                        </td>
                        <td className="num money">{p.price === null ? "-" : money(p.price * l.qty)}</td>
                        <td>
                          <button
                            type="button"
                            className="remove"
                            onClick={() => setLines((prev) => prev.filter((x) => x.catalog_item_id !== l.catalog_item_id))}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td colSpan={3}>
                      <b>Customer subtotal (before tax)</b>
                    </td>
                    <td className="num money">{money(linesTotal)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {missingPrice && (
            <div className="notice danger">An item has no price for this customer. Set a fleet price before creating the order.</div>
          )}

          <h3 style={{ marginTop: 22 }}>Assignment</h3>
          <div className="field">
            <label htmlFor="internal_notes">Internal notes</label>
            <textarea id="internal_notes" name="internal_notes" rows={4} maxLength={2000} placeholder="Only CDS staff see these notes." />
          </div>
          <div className="notice">The affiliate sees approved work and its settlement amount, but not the customer sell price.</div>
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-primary" type="submit" disabled={pending || missingPrice}>
              {pending ? "Creating..." : "Create Work Order"}
            </button>
          </div>
        </section>
      </div>
    </form>
  );
}
