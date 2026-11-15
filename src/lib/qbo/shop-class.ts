import type { createClient } from "@/lib/supabase/server";

/**
 * The QuickBooks Class of a shop's invoices (CDS, Sarah 2026-11-13): always the shop's
 * "CDS <city>" class, for example CDS Houston for a Houston shop; orders assigned to
 * Enviromotive get CDS INC. Used when the shop has no qbo_affiliate_class row yet: the class
 * is picked from QuickBooks's active Classes and remembered in that table, where CDS can
 * correct it. Never stops an invoice: no match or a failure means no class, as before.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

/** Class entity (only the fields used): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/class */
export type QboClass = { Id: string; Name: string; Active?: boolean };
export type ShopClass = { id: string; name: string };
export type ShopForClass = { city: string | null; displayName: string | null; shortCode: string | null };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const why = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/**
 * The shop's class among the active classes, or null. The shop's city, name (with or without
 * a leading "CDS") and code are matched against the part after "CDS " in the class name,
 * ignoring case, spaces and punctuation. When these point at more than one class (or two
 * active classes share a name) it is null rather than a guess, since the pick is remembered.
 */
export function matchShopClass(shop: ShopForClass, classes: QboClass[]): ShopClass | null {
  const active = classes.filter((c) => c.Active !== false && c.Id?.trim() && c.Name?.trim() && c.Id.trim().length <= 50);
  const only = (hits: QboClass[]): ShopClass | null => {
    const ids = new Set(hits.map((c) => c.Id.trim()));
    if (ids.size !== 1) return null;
    return { id: hits[0].Id.trim(), name: hits[0].Name.trim().slice(0, 500) };
  };

  if (/enviromotive/i.test(`${shop.displayName ?? ""} ${shop.shortCode ?? ""}`)) {
    return only(active.filter((c) => norm(c.Name) === "cdsinc"));
  }

  const byKey = new Map<string, QboClass[]>();
  for (const c of active) {
    const m = /^cds\s+(.+)$/i.exec(c.Name.trim());
    const key = m ? norm(m[1]) : "";
    if (!key || key === "inc") continue;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const name = shop.displayName ?? "";
  const keys = new Set([shop.city, name, name.replace(/^\s*cds\b/i, ""), shop.shortCode].map(norm).filter(Boolean));
  return only([...keys].flatMap((k) => byKey.get(k) ?? []));
}

/** Reads the shop and the classes and picks the class. Null on no match or any failure. */
export async function findShopClass(supabase: Db, listClasses: () => Promise<QboClass[]>, affiliateId: string): Promise<ShopClass | null> {
  try {
    const { data, error } = await supabase.from("affiliates").select("display_name, short_code, city").eq("id", affiliateId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const shop = data as { display_name: string | null; short_code: string | null; city: string | null };
    return matchShopClass({ city: shop.city, displayName: shop.display_name, shortCode: shop.short_code }, await listClasses());
  } catch (e) {
    console.error(`qbo_affiliate_class: could not pick a QuickBooks Class for shop ${affiliateId}: ${why(e)}`);
    return null;
  }
}

/**
 * Remembers the class for the shop. Insert only: a row CDS added meanwhile is kept. RLS
 * (cds_all on qbo_affiliate_class) allows this for the signed-in CDS user. Never throws.
 */
export async function saveShopClass(supabase: Db, affiliateId: string, cls: ShopClass, updatedBy: string | null): Promise<void> {
  try {
    const { error } = await supabase
      .from("qbo_affiliate_class")
      .upsert(
        { affiliate_id: affiliateId, qbo_class_id: cls.id, qbo_class_name: cls.name, updated_by: updatedBy },
        { onConflict: "affiliate_id", ignoreDuplicates: true },
      );
    if (error) console.error(`qbo_affiliate_class: could not remember ${cls.name} for shop ${affiliateId}: ${error.message}`);
  } catch (e) {
    console.error(`qbo_affiliate_class: could not remember ${cls.name} for shop ${affiliateId}: ${why(e)}`);
  }
}
