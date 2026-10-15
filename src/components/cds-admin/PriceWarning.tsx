"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./cds-admin.module.css";
import { BELOW_SHOP_RATE_MESSAGE, belowShopRate } from "./margin";

export function BelowShopRate({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className={styles.warn} role="status">
      {BELOW_SHOP_RATE_MESSAGE}. You can still save.
    </p>
  );
}

/** Shop Rate and Fleet Price inputs of a catalog item, with a live negative margin warning. */
export function CatalogPriceFields({ k, rate, sell }: { k: string; rate?: string | null; sell?: string | null }) {
  const [shopRate, setShopRate] = useState(rate ?? "");
  const [fleet, setFleet] = useState(sell ?? "");
  const rateRef = useRef<HTMLInputElement>(null);
  // The add form is reset after a successful save: clear the prices with it.
  useEffect(() => {
    const form = rateRef.current?.form;
    if (!form) return;
    const onReset = () => {
      setShopRate(rate ?? "");
      setFleet(sell ?? "");
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [rate, sell]);
  return (
    <>
      <div className="field">
        <label htmlFor={`rate-${k}`}>Shop Rate (USD)</label>
        <input
          className="input"
          ref={rateRef}
          id={`rate-${k}`}
          name="shop_rate"
          type="number"
          min="0"
          step="0.01"
          value={shopRate}
          onChange={(e) => setShopRate(e.target.value)}
          placeholder="What CDS pays the shop"
        />
      </div>
      <div className="field">
        <label htmlFor={`fleet-${k}`}>Fleet Price (USD)</label>
        <input
          className="input"
          id={`fleet-${k}`}
          name="fleet_price"
          type="number"
          min="0"
          step="0.01"
          value={fleet}
          onChange={(e) => setFleet(e.target.value)}
          placeholder="Default customer price"
        />
        <BelowShopRate show={belowShopRate(shopRate, fleet)} />
      </div>
    </>
  );
}

/** A customer override input with a live warning when it is below the shop rate. */
export function OverrideInput({
  shopRate,
  defaultValue,
  ariaLabel,
  children,
}: {
  shopRate: string | null;
  defaultValue: string;
  ariaLabel: string;
  children?: ReactNode;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <>
      <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
        <input
          className="input"
          style={{ maxWidth: 110, padding: "6px 8px" }}
          name="amount"
          type="number"
          min="0"
          step="0.01"
          placeholder="Default"
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {children}
      </div>
      <BelowShopRate show={belowShopRate(shopRate, value)} />
    </>
  );
}
