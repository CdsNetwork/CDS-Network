"use client";

import { useState } from "react";
import { LocationPicker } from "./LocationPicker";
import type { LocationOption } from "./NewWorkOrderForm";

type Props = {
  customerId: string;
  /** The order's customer's locations. */
  locations: LocationOption[];
  locationId: string | null;
};

/**
 * The Location / Branch picker alone, for the location edit after dispatch
 * (updateWorkOrderLocation): only the order's own customer's locations. The label and ship-to
 * address follow the chosen location; the shop and fulfillment stay.
 */
export function OrderLocationOnlyField({ customerId, locations, locationId }: Props) {
  const start = locations.find((l) => l.id === locationId) ?? null;
  const [location, setLocation] = useState<LocationOption | null>(start);
  const [query, setQuery] = useState(start ? `${start.code} - ${start.name}` : "");

  return (
    <>
      <input type="hidden" name="location_id" value={location?.id ?? ""} />
      <LocationPicker
        inputId="edit-location-only"
        customerId={customerId}
        locations={locations}
        location={location}
        query={query}
        onQueryChange={setQuery}
        onChoose={(l) => {
          setLocation(l);
          setQuery(`${l.code} - ${l.name}`);
        }}
        onClear={() => setLocation(null)}
        showRouting={false}
      />
    </>
  );
}
