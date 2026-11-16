import type { SearchOption } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { removeVendorLinkConfirm } from "@/components/cds-admin/confirm";
import styles from "@/components/cds-admin/cds-admin.module.css";
import { FormSearchSelect } from "@/components/cds-wo/FormSearchSelect";
import { listBillAccounts, listTerms, listVendors, type QboAccount, type QboTerm } from "@/lib/qbo/api";
import { BILL_SETTING_KEY, defaultBillTerm, parseBillSetting, suggestVendor, type QboVendor } from "@/lib/qbo/bill";
import { qboApi } from "@/lib/qbo/tokens";
import { dateTime, wrapCell } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { linkSuggestedVendor, removeVendorMap, saveBillSetting, saveVendorMap } from "./qbo-actions";

type Shop = { id: string; short_code: string; display_name: string; city: string | null; region: string | null };
type VendorMap = { affiliate_id: string; qbo_vendor_id: string; qbo_vendor_name: string };

type Lists = { vendors: QboVendor[]; accounts: QboAccount[]; terms: QboTerm[] } | null;

async function billLists(connected: boolean): Promise<{ lists: Lists; error: string | null }> {
  if (!connected) return { lists: null, error: null };
  try {
    const api = await qboApi();
    const [vendors, accounts, terms] = await Promise.all([listVendors(api), listBillAccounts(api), listTerms(api)]);
    return { lists: { vendors, accounts, terms }, error: null };
  } catch (e) {
    return { lists: null, error: `QuickBooks vendors and accounts could not be loaded (${e instanceof Error ? e.message : "unknown error"}). Enter ids by hand or reload.` };
  }
}

/**
 * Shop bills (M3) on Admin > QuickBooks mappings: each shop's QuickBooks vendor (suggested by
 * name, CDS confirms or picks another), the account for shipping deductions, optional terms,
 * and the switch that turns bills on. Bill lines use each item's own QuickBooks item.
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
  const accountOptions: SearchOption[] | null = lists
    ? lists.accounts.map((a) => ({
        value: `account::${a.Id}::${a.FullyQualifiedName ?? a.Name}`,
        label: a.FullyQualifiedName ?? a.Name,
        hint: [a.AccountType, a.AcctNum && `No. ${a.AcctNum}`, `QuickBooks id ${a.Id}`].filter(Boolean).join(" - "),
      }))
    : null;
  const termsValue = setting?.termsId ? `${setting.termsId}::${setting.termsName ?? ""}` : "";
  // CDS books freight deductions to GL 5030 (CDS, 2026-11-16): suggested until an account is saved.
  const suggested5030 = !setting?.deduction ? lists?.accounts.filter((a) => a.AcctNum?.trim() === "5030") : null;
  const deductionDefault = suggested5030?.length === 1 ? `account::${suggested5030[0].Id}::${suggested5030[0].FullyQualifiedName ?? suggested5030[0].Name}` : "";
  const net30 = lists ? defaultBillTerm(lists.terms) : null;
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

      <p className="small">Each bill line uses the item&apos;s own QuickBooks item, so QuickBooks books it to that item&apos;s expense account.</p>
      {setting ? (
        <p>
          Shop bills are on
          <span className="small">
            {" "}
            since {setting.since ? dateTime(setting.since) : "the start"}
            {settingBy ? `, set by ${settingBy}` : ""}
          </span>
          . Shipping deductions go to{" "}
          {setting.deduction ? (
            <>
              <b>{setting.deduction.name}</b> <span className="small">(id {setting.deduction.id})</span>
            </>
          ) : (
            "no account yet"
          )}
          {setting.termsName ? `, terms ${setting.termsName}` : ""}.
        </p>
      ) : (
        <div className="notice warning">QuickBooks bills are not turned on yet.</div>
      )}
      {setting && !setting.deduction && (
        <div className="notice warning">Choose the account for shipping deductions: orders with a shipping deduction wait for it.</div>
      )}
      <ActionForm action={saveBillSetting} submitLabel={setting ? "Save" : "Turn on shop bills"} resetOnSuccess>
        {accountOptions ? (
          <div className="grid2">
            <div className="field">
              <label htmlFor="bill-target">Account for shipping deductions</label>
              <FormSearchSelect
                id="bill-target"
                name="bill_target"
                options={accountOptions}
                defaultValue={deductionDefault}
                placeholder={setting?.deduction ? `Keep ${setting.deduction.name}` : "Type the account name"}
                limit={150}
              />
            </div>
            <div className="field">
              <label htmlFor="bill-terms">Terms</label>
              <select id="bill-terms" name="bill_terms" className="input" defaultValue={termsValue}>
                <option value="">{net30 ? `${net30.name} (the default)` : "The vendor's own terms"}</option>
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
              <label htmlFor="bill-kind">Shipping deductions go to</label>
              <select id="bill-kind" name="bill_kind" className="input" defaultValue="account">
                <option value="account">Expense account</option>
                <option value="item">Product or service item</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="bill-target-id">QuickBooks id</label>
              <input id="bill-target-id" name="bill_target_id" className="input" inputMode="numeric" pattern="[0-9]+" maxLength={50} />
            </div>
            <div className="field">
              <label htmlFor="bill-target-name">Name</label>
              <input id="bill-target-name" name="bill_target_name" className="input" maxLength={500} />
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
