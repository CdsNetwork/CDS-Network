/**
 * The shops on Admin > Shop bills, for linking each to its QuickBooks vendor. CDS's in-house
 * shop is listed first and labelled as in-house: linked to the vendor CDS buys the parts from
 * (GESi), its orders get a bill at CDS cost (./bill); not linked, they get none. It is never
 * suggested a vendor by its own name and is not counted among the shops still to link.
 */

export type VendorLinkShop = {
  id: string;
  short_code: string;
  display_name: string;
  city: string | null;
  region: string | null;
  is_in_house: boolean;
};

export type VendorLinkRow = { affiliate_id: string; qbo_vendor_id: string; qbo_vendor_name: string };

export type VendorLinkShopRow = VendorLinkShop & { inHouse: boolean; link: VendorLinkRow | null; suggest: boolean };

const IN_HOUSE_HINT = "In-house: bills at CDS cost";

export function vendorLinkShops(
  shops: readonly VendorLinkShop[],
  links: ReadonlyMap<string, VendorLinkRow>,
): { rows: VendorLinkShopRow[]; options: { value: string; label: string; hint: string }[]; unlinked: number } {
  const rows = [...shops]
    .sort((a, b) => Number(b.is_in_house) - Number(a.is_in_house))
    .map((s) => ({ ...s, inHouse: s.is_in_house, link: links.get(s.id) ?? null, suggest: !s.is_in_house }));
  const options = rows.map((s) => {
    const state = s.link ? `QuickBooks: ${s.link.qbo_vendor_name}` : s.inHouse ? "Not linked: no bills" : "Not linked";
    return { value: s.id, label: s.display_name, hint: s.inHouse ? `${IN_HOUSE_HINT}. ${state}` : state };
  });
  return { rows, options, unlinked: rows.filter((s) => !s.inHouse && !s.link).length };
}
