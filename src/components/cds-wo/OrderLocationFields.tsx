"use client";

import { useMemo, useState } from "react";
import { FULFILLMENT_LABEL } from "@/lib/format";
import { LocationPicker } from "./LocationPicker";
import type { LocationOption } from "./NewWorkOrderForm";

type Props = {
  customers: { id: string; code: string; name: string }[];
  locations: LocationOption[];
  /** Locations the email intake matched for this order: listed first. */
  candidateIds: string[];
  initial: {
    customerId: string;
    locationId: string | null;
    locationLabel: string;
    siteAddress: string;
    requestType: string;
    fulfillment: string;
  };
};

/**
 * Customer, Location / Branch, location label, ship-to address, request type and fulfillment
 * for the Edit order box. Picking a location fills the label, the ship-to address and the
 * fulfillment the way the Create Work Order form does.
 */
export function OrderLocationFields({ customers, locations, candidateIds, initial }: Props) {
  const [customerId, setCustomerId] = useState(initial.customerId);
  const start = locations.find((l) => l.id === initial.locationId) ?? null;
  const [location, setLocation] = useState<LocationOption | null>(start);
  // A location that is not in the picker (inactive) stays on the order until CDS changes it.
  const [keptId, setKeptId] = useState(start ? "" : (initial.locationId ?? ""));
  const [query, setQuery] = useState(start ? `${start.code} - ${start.name}` : initial.locationLabel);
  const [label, setLabel] = useState(initial.locationLabel);
  const [siteAddress, setSiteAddress] = useState(initial.siteAddress);
  const [requestType, setRequestType] = useState(initial.requestType);
  const [fulfillment, setFulfillment] = useState(initial.fulfillment);

  const customerLocations = useMemo(() => locations.filter((l) => l.customer_id === customerId), [locations, customerId]);
  const candidates = customerId === initial.customerId ? candidateIds : [];

  function chooseLocation(l: LocationOption) {
    setLocation(l);
    setKeptId("");
    setQuery(`${l.code} - ${l.name}`);
    setLabel(`${l.code} ${l.name}`);
    setSiteAddress(l.address_raw);
    if (requestType !== "parts_only") setFulfillment(l.fulfillment);
  }

  function clearLocation() {
    setLocation(null);
    setKeptId("");
  }

  function onCustomerChange(id: string) {
    setCustomerId(id);
    clearLocation();
    setQuery("");
  }

  function onRequestTypeChange(value: string) {
    setRequestType(value);
    if (value === "parts_only") setFulfillment("supplier_direct");
    else if (location) setFulfillment(location.fulfillment);
  }

  return (
    <>
      <input type="hidden" name="location_id" value={location?.id ?? keptId} />
      <div className="field">
        <label htmlFor="edit-customer">
          Customer <span className="req">*</span>
        </label>
        <select id="edit-customer" name="customer_id" required value={customerId} onChange={(e) => onCustomerChange(e.target.value)}>
          <option value="">Select customer...</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <LocationPicker
        inputId="edit-location"
        customerId={customerId}
        locations={customerLocations}
        location={location}
        query={query}
        onQueryChange={setQuery}
        onChoose={chooseLocation}
        onClear={clearLocation}
        candidateIds={candidates}
      />
      <div className="field">
        <label htmlFor="edit-loc">
          Location label <span className="req">*</span>
        </label>
        <input id="edit-loc" name="location_label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="edit-addr">Site / ship-to address</label>
        <input
          id="edit-addr"
          name="site_address"
          className="input"
          value={siteAddress}
          onChange={(e) => setSiteAddress(e.target.value)}
          maxLength={500}
        />
      </div>
      <div className="field">
        <label htmlFor="edit-type">Request Type</label>
        <select id="edit-type" name="request_type" value={requestType} onChange={(e) => onRequestTypeChange(e.target.value)}>
          <option value="service">Service / Cleaning</option>
          <option value="parts_only">Parts Only</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="edit-ful">Fulfillment</label>
        <select id="edit-ful" name="fulfillment" value={fulfillment} onChange={(e) => setFulfillment(e.target.value)}>
          {Object.entries(FULFILLMENT_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
