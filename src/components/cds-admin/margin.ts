/** Shown wherever a customer price is below the shop rate. Saving stays allowed. */
export const BELOW_SHOP_RATE_MESSAGE = "Customer price is below what CDS pays the shop";

type Amount = number | string | null | undefined;

/** True when both prices are known and the customer price is below the shop rate. */
export function belowShopRate(shopRate: Amount, customerPrice: Amount): boolean {
  if (shopRate === null || shopRate === undefined || shopRate === "") return false;
  if (customerPrice === null || customerPrice === undefined || customerPrice === "") return false;
  const rate = Number(shopRate);
  const price = Number(customerPrice);
  return Number.isFinite(rate) && Number.isFinite(price) && price < rate;
}
