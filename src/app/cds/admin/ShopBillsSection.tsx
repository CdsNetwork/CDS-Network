import type { SearchOption } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { removeVendorLinkConfirm } from "@/components/cds-admin/confirm";
import styles from "@/components/cds-admin/cds-admin.module.css";
import { FormSearchSelect } from "@/components/cds-wo/FormSearchSelect";
import { listBillAccounts, listItems, listTerms, listVendors, type QboAccount, type QboItem, type QboTerm } from "@/lib/qbo/api";
import { BILL_SETTING_KEY, parseBillSetting, suggestVendor, type QboVendor } from "@/lib/qbo/bill";
import { qboApi } from "@/lib/qbo/tokens";
import { dateTime, wrapCell } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { linkSuggestedVendor, removeVendorMap, saveBillSetting, saveVendorMap } from "./qbo-actions";

type Shop = { id: string; short_code: string; display_name: string; city: string | null; region: string | null };
type VendorMap = { affiliate_id: string; qbo_vendor_id: string; qbo_vendor_name: string };

type Lists = { vendors: QboVendor[]; accounts: QboAccount[]; items: QboItem[]; terms: QboTerm[] } | null;

async function billLists(connected: boolean): Promise<{ lists: Lists; error: string | null }> {
  if (!connected) return { lists: null, error: null };
  try {
    const api = await qboApi();
    const [vendors, accounts, items, terms] = await Promise.all([listVendors(api), listBillAccounts(api), listItems(api), listTerms(api)]);
    return { lists: { vendors, accounts, items, terms }, error: null };
  } catch (e) {
    return { lists: null, error: `QuickBooks vendors and accounts could not be loaded (${e instanceof Error ? e.message : "unknown error"}). Enter ids by hand or reload.` };
  }
}

/**
 * Shop bills (M3) on Admin > QuickBooks mappings: the account or item the bill lines go to,
 * and each shop's QuickBooks vendor (suggested by name, CDS confirms or picks another).
 */
export async function ShopBillsSection({ connected }: { connected: boolean }) {
  const supabase = await createClient();
  const [shopsRes, mapRes, settingRes, { lists, error: listError }] = await Promise.all([
    supabase.from("affiliates").select("id, short_code, display_name, city, region").eq("active", true).eq("is_in_house", false).order("display_name"),
    supabase.from("qbo_affiliate_vendor").select("affiliate_id, qbo_vendor_id, qbo_vendor_name"),
    supabase.from("app_settings").select("value, updated_at, profiles(full_name)").eq("key", BILL_SETTING_KEY).maybeSingle(),
    billLists(connected),
  ]);
  const loadError = [shopsRes, mapRes, settingRes].some((r) => r.error);
  const shops = (shopsRes.data ?? []) as Shop[];
  const links = new Map(((mapRes.data ?? []) as VendorMap[]).map((m) => [m.affiliate_id, m]));
  const setting = parseBillSetting((settingRes.data as { value: unknown } | null)?.value);
  const settingBy = (() => {
    const p = (settingRes.data as { profiles?: { full_name: string } | { full_name: string }[] | null } | null)?.profiles;
    return (Array.isArray(p) ? p[0] : p)?.full_name ?? null;
  })();

  const shopOptions: SearchOption[] = shops.map((s) => ({
    value: s.id,
    label: s.display_name,
    hint: links.get(s.id) ? `QuickBooks: ${links.get(s.id)!.qbo_vendor_name}` : "Not linked",
  }));
  const vendorOptions: SearchOption[] | null =
    lists?.vendors.map((v) => ({
      value: `${v.Id}::${v.DisplayName}`,
      label: v.DisplayName,
      hint: `QuickBooks id ${v.Id}${v.CompanyName && v.CompanyName !== v.DisplayName ? ` - ${v.CompanyName}` : ""}`,
    })) ?? null;
  const targetOptions: SearchOption[] | null = lists
    ? [
        ...lists.accounts.map((a) => ({
          value: `account::${a.Id}::${a.FullyQualifiedName ?? a.Name}`,
          label: `Account: ${a.FullyQualifiedName ?? a.Name}`,
          hint: [a.AccountType, a.AcctNum && `No. ${a.AcctNum}`, `QuickBooks id ${a.Id}`].filter(Boolean).join(" - "),
        })),
        ...lists.items.map((i) => ({
          value: `item::${i.Id}::${i.Name}`,
          label: `Item: ${i.FullyQualifiedName ?? i.Name}`,
          hint: [i.Type, `QuickBooks id ${i.Id}`].filter(Boolean).join(" - "),
        })),
      ]
    : null;
  const unlinked = shops.filter((s) => !links.has(s.id)).length;

  return (
    <div className="section">
      <h3>Shop bills</h3>
      <p className="small">
        When a shop completes a work order, the portal creates the shop&apos;s bill in QuickBooks: the shop&apos;s vendor, its
        invoice number, and the same amounts the shop sees (deductions included). A bill waits while a shop rate is TBD and is
        created when CDS enters the last rate. Orders completed before bills were turned on get no bill automatically; the work
        order page has a Create bill button.
      </p>
      {listError && <div className="notice danger">{listError}</div>}
      {loadError && <div className="notice danger">Some shop bill settings could not be loaded. Refresh the page to try again.</div>}

      <h4 style={{ marginTop: 16 }}>Account or item for bill lines</h4>
      {setting ? (
        <p>
          Bill lines go to QuickBooks {setting.kind === "account" ? "account" : "item"} <b>{setting.name}</b>{" "}
          <span className="small">(id {setting.id})</span>
          {setting.termsName ? `, terms ${setting.termsName}` : ""}.
          <span className="small">
            {" "}
            Bills since {setting.since ? dateTime(setting.since) : "the start"}
            {settingBy ? `, set by ${settingBy}` : ""}.
          </span>
        </p>
      ) : (
        <div className="notice warning">QuickBooks bills are not set up yet. Choose the account or item the bill lines go to.</div>
      )}
      <ActionForm action={saveBillSetting} submitLabel={setting ? "Change" : "Turn on shop bills"} resetOnSuccess>
        {targetOptions ? (
          <div className="grid2">
            <div className="field">
              <label htmlFor="bill-target">
                Expense account or item <span className="req">*</span>
              </label>
              <FormSearchSelect id="bill-target" name="bill_target" options={targetOptions} required placeholder="Type the account or item name" limit={150} />
            </div>
            <div className="field">
              <label htmlFor="bill-terms">Terms</label>
              <select id="bill-terms" name="bill_terms" className="input" defaultValue="">
                <option value="">The vendor&apos;s own terms</option>
                {lists!.terms.map((t) => (
                  <option key={t.Id} value={`${t.Id}::${t.Name}`}>
                    {t.Name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="grid3">
            <div className="field">
              <label htmlFor="bill-kind">
                Type <span className="req">*</span>
              </label>
              <select id="bill-kind" name="bill_kind" className="input" required defaultValue="">
                <option value="" disabled>
                  Choose
                </option>
                <option value="account">Expense account</option>
                <option value="item">Product or service item</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="bill-target-id">
                QuickBooks id <span className="req">*</span>
              </label>
              <input id="bill-target-id" name="bill_target_id" className="input" required inputMode="numeric" pattern="[0-9]+" maxLength={50} />
            </div>
            <div className="field">
              <label htmlFor="bill-target-name">
                Name <span className="req">*</span>
              </label>
              <input id="bill-target-name" name="bill_target_name" className="input" required maxLength={500} />
            </div>
          </div>
        )}
      </ActionForm>

      <h4 style={{ marginTop: 16 }}>Shop vendors</h4>
      <ActionForm action={saveVendorMap} submitLabel="Link vendor" resetOnSuccess>
        <div className="grid2">
          <div className="field">
            <label htmlFor="vmap-shop">
              Shop <span className="req">*</span>
            </label>
            <FormSearchSelect id="vmap-shop" name="affiliate_id" options={shopOptions} required placeholder="Type a shop name" />
          </div>
          {vendorOptions ? (
            <div className="field">
              <label htmlFor="vmap-vendor">
                QuickBooks vendor <span className="req">*</span>
              </label>
              <FormSearchSelect id="vmap-vendor" name="qbo_vendor" options={vendorOptions} required placeholder="Type the vendor name as in QuickBooks" limit={150} />
            </div>
          ) : (
            <div className="grid2" style={{ gap: 10 }}>
              <div className="field">
                <label htmlFor="vmap-vendor-id">
                  QuickBooks vendor id <span className="req">*</span>
                </label>
                <input id="vmap-vendor-id" name="qbo_vendor_id" className="input" required inputMode="numeric" pattern="[0-9]+" maxLength={50} />
              </div>
              <div className="field">
                <label htmlFor="vmap-vendor-name">
                  Vendor name <span className="req">*</span>
                </label>
                <input id="vmap-vendor-name" name="qbo_vendor_name" className="input" required maxLength={500} />
              </div>
            </div>
          )}
        </div>
      </ActionForm>
      <div className="tablewrap" style={{ marginTop: 14 }}>
        <table className={styles.cardTable}>
          <thead>
            <tr>
              <th>Shop</th>
              <th>QuickBooks vendor</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shops.length === 0 && (
              <tr>
                <td colSpan={3} className="small">
                  No active shops.
                </td>
              </tr>
            )}
            {shops.map((s) => {
              const link = links.get(s.id);
              const suggested = !link && lists ? suggestVendor(s.display_name, lists.vendors) : null;
              return (
                <tr key={s.id}>
                  <td className={wrapCell(s.display_name)} data-label="Shop">
                    <b>{s.display_name}</b>
                    {s.city ? <span className="small"> {[s.city, s.region].filter(Boolean).join(", ")}</span> : null}
                  </td>
                  <td data-label="QuickBooks vendor">
                    {link ? (
                      <>
                        {link.qbo_vendor_name} <span className="small">(id {link.qbo_vendor_id})</span>
                      </>
                    ) : suggested ? (
                      <>
                        <span className="tag">Not linked</span> <span className="small">Suggested: {suggested.DisplayName}</span>
                      </>
                    ) : (
                      <span className="tag">Not linked</span>
                    )}
                  </td>
                  <td>
                    {link ? (
                      <ActionForm
                        action={removeVendorMap.bind(null, s.id)}
                        submitLabel="Remove"
                        confirmText={removeVendorLinkConfirm(s.display_name, link.qbo_vendor_name)}
                        pendingLabel="..."
                        submitClassName="btn btn-secondary btn-small"
                      />
                    ) : suggested ? (
                      <ActionForm
                        action={linkSuggestedVendor.bind(null, s.id, suggested.Id, suggested.DisplayName)}
                        submitLabel="Link"
                        pendingLabel="..."
                        submitClassName="btn btn-secondary btn-small"
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">{unlinked === 0 ? "Every active shop is linked." : `${unlinked} active shops are not linked yet.`}</p>
    </div>
  );
}
