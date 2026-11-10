import { describe, expect, it } from "vitest";
import { pickShopRate, pickShopRatesByItem, shopRateSource, type ShopRateRow } from "@/lib/shop-rates";

const SHOP = "shop-a";
const OTHER_SHOP = "shop-b";
const FIRST_STUDENT = "cust-fs";
const RYDER = "cust-ryder";

const row = (
  affiliate_id: string | null,
  customer_id: string | null,
  amount: number | null,
  effective_from = "2026-01-01",
): ShopRateRow => ({ affiliate_id, customer_id, amount, effective_from });

describe("pickShopRate: same precedence as private.shop_rate_pick", () => {
  const def = row(null, null, 100);
  const fs = row(null, FIRST_STUDENT, 150);
  const own = row(SHOP, null, 120);
  const ownFs = row(SHOP, FIRST_STUDENT, 170);
  const all = [def, fs, own, ownFs];

  it("a customer's rate beats the default", () => {
    expect(pickShopRate([def, fs], null, FIRST_STUDENT)).toBe(fs);
    expect(pickShopRate([def, fs], OTHER_SHOP, FIRST_STUDENT)).toBe(fs);
  });

  it("the shop's rate for the customer beats the customer's rate", () => {
    expect(pickShopRate(all, SHOP, FIRST_STUDENT)).toBe(ownFs);
  });

  it("the customer's rate beats the shop's own rate for any customer", () => {
    expect(pickShopRate([def, fs, own], SHOP, FIRST_STUDENT)).toBe(fs);
  });

  it("for other customers the shop's own rate still beats the default", () => {
    expect(pickShopRate(all, SHOP, RYDER)).toBe(own);
    expect(pickShopRate(all, OTHER_SHOP, RYDER)).toBe(def);
  });

  it("never uses another shop's or another customer's row", () => {
    expect(pickShopRate([row(OTHER_SHOP, null, 1), row(null, RYDER, 2)], SHOP, FIRST_STUDENT)).toBeNull();
    expect(pickShopRate([row(SHOP, RYDER, 1), def], SHOP, FIRST_STUDENT)).toBe(def);
  });

  it("within a level the latest start date wins", () => {
    const older = row(null, FIRST_STUDENT, 140, "2026-01-01");
    const newer = row(null, FIRST_STUDENT, 160, "2026-06-01");
    expect(pickShopRate([newer, older, def], null, FIRST_STUDENT)).toBe(newer);
    expect(pickShopRate([older, newer, def], null, FIRST_STUDENT)).toBe(newer);
  });

  it("skips a shop or customer row without an amount, but not a default row", () => {
    const emptyFs = row(null, FIRST_STUDENT, null);
    expect(pickShopRate([def, emptyFs], null, FIRST_STUDENT)).toBe(def);
    const emptyDefault = row(null, null, null);
    expect(pickShopRate([emptyDefault], null, FIRST_STUDENT)).toBe(emptyDefault);
  });

  it("names the source", () => {
    expect([def, fs, own, ownFs].map(shopRateSource)).toEqual(["default", "customer", "shop", "shop"]);
  });
});

it("pickShopRatesByItem picks per catalog item", () => {
  const rows = [
    { ...row(null, null, 100), catalog_item_id: "gesi" },
    { ...row(null, FIRST_STUDENT, 150), catalog_item_id: "gesi" },
    { ...row(null, null, 10), catalog_item_id: "gasket" },
  ];
  const fs = pickShopRatesByItem(rows, SHOP, FIRST_STUDENT);
  expect(fs.get("gesi")?.amount).toBe(150);
  expect(fs.get("gasket")?.amount).toBe(10);
  const ryder = pickShopRatesByItem(rows, SHOP, RYDER);
  expect(ryder.get("gesi")?.amount).toBe(100);
});
