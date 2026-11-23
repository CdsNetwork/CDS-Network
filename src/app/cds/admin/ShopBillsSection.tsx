import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import type { SearchOption } from "@/components/SearchSelect";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { removeVendorLinkConfirm } from "@/components/cds-admin/confirm";
import styles from "@/components/cds-admin/cds-admin.module.css";
import { FormSearchSelect } from "@/components/cds-wo/FormSearchSelect";
import { deductionOptions } from "@/lib/qbo/deduction-options";
import { qboBillLists, type QboBillLists } from "@/lib/qbo/lists";
import { qboStatus } from "@/lib/qbo/status";
import { BILL_SETTING_KEY, defaultBillTerm, parseBillSetting, suggestVendor, type BillLineSetting } from "@/lib/qbo/bill";
import { vendorLinkShops, type VendorLinkRow, type VendorLinkShop } from "@/lib/qbo/bill-shops";
import { dateTime, wrapCell } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { linkSuggestedVendor, removeVendorMap, saveBillSetting, saveVendorMap } from "./qbo-actions";

type Shop = VendorLinkShop;

type Lists = Promise<QboBillLists>;

/** Admin > Shop bills. */
export async function ShopBillsTab() {
  const status = await qboStatus(await createClient());
  return (
    <>
      {!status.connected && (
        <div className="section">
          <div className="notice warning">
            QuickBooks is not connected, so its vendors and accounts cannot be shown. Enter the QuickBooks ids by hand, or{" "}
            <Link className="link" href="/cds/admin?tab=settings">
              connect QuickBooks in Settings
            </Link>
            .
          </div>
        </div>
      )}
      <ShopBillsSection connected={status.connected} />
    </>
  );
}

/**
 * Shop bills (M3) on Admin > Shop bills: each shop's QuickBooks vendor (suggested by
 * name, CDS confirms or picks another), the account for shipping deductions, optional terms,
 * and the switch that turns bills on. Bill lines use each item's own QuickBooks item.
 * The QuickBooks lists stream in (Suspense): the shops and settings show at once.
 */
export async function ShopBillsSection({ connected }: { connected: boolean }) {
  const supabase = await createClient();
  // Not awaited: the QuickBooks lists can take seconds.
  const lists = qboBillLists(connected);
  const [shopsRes, mapRes, settingRes] = await Promise.all([
    // CDS's in-house shop too: linked to its vendor (GESi), its orders are billed at CDS cost.
    supabase.from("affiliates").select("id, short_code, display_name, city, region, is_in_house").eq("active", true).order("display_name"),
    supabase.from("qbo_affiliate_vendor").select("affiliate_id, qbo_vendor_id, qbo_vendor_name"),
    supabase.from("app_settings").select("value, updated_at, profiles(full_name)").eq("key", BILL_SETTING_KEY).maybeSingle(),
  ]);
  const loadError = [shopsRes, mapRes, settingRes].some((r) => r.error);
  const links = new Map(((mapRes.data ?? []) as VendorLinkRow[]).map((m) => [m.affiliate_id, m]));
  const { rows: shops, options: shopOptions, unlinked } = vendorLinkShops((shopsRes.data ?? []) as Shop[], links);
  const setting = parseBillSetting((settingRes.data as { value: unknown } | null)?.value);
  const settingBy = (() => {
    const p = (settingRes.data as { profiles?: { full_name: string } | { full_name: string }[] | null } | null)?.profiles;
    return (Array.isArray(p) ? p[0] : p)?.full_name ?? null;
  })();


  return (
    <div className="section">
      <h3>Shop bills</h3>
      <p className="small">
        When a shop completes a work order, the shop&apos;s bill waits for CDS (AFF Bill Pnd Approval on the dashboard): the
        work order page shows the bill with the shop&apos;s vendor, its invoice number and the same amounts the shop sees
        (deductions included), and Approve and send to QuickBooks creates it. A shop rate still TBD is entered first. Orders
        completed before bills were turned on are not flagged on the dashboard (they may already be in QuickBooks).
      </p>
      <p className="small">
        CDS Inc (in-house): link it to the vendor CDS buys those parts from, and its orders get a bill at CDS cost, with no
        shipping deduction, after CDS approves it. Orders completed before the link are not flagged. Not linked, in-house orders
        get no bill.
      </p>
      <Suspense fallback={null}>
        <ListsError lists={lists} />
      </Suspense>
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
        <Loading what="QuickBooks accounts and terms">
          <SettingFields lists={lists} setting={setting} />
        </Loading>
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
          <Loading what="QuickBooks vendors">
            <VendorPicker lists={lists} />
          </Loading>
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
              const link = s.link;
              return (
                <tr key={s.id}>
                  <td className={wrapCell(s.display_name)} data-label="Shop">
                    <b>{s.display_name}</b>
                    {s.inHouse ? (
                      <>
                        {" "}
                        <span className="tag">In-house: billed at CDS cost</span>
                      </>
                    ) : null}
                    {s.city ? <span className="small"> {[s.city, s.region].filter(Boolean).join(", ")}</span> : null}
                  </td>
                  <td data-label="QuickBooks vendor">
                    {link ? (
                      <>
                        {link.qbo_vendor_name} <span className="small">(id {link.qbo_vendor_id})</span>
                      </>
                    ) : (
                      <>
                        <span className="tag">{s.inHouse ? "Not linked: in-house orders get no bill" : "Not linked"}</span>
                        {s.suggest && (
                          <Suspense fallback={null}>
                            <Suggested lists={lists} shopName={s.display_name} />
                          </Suspense>
                        )}
                      </>
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
                    ) : s.suggest ? (
                      <Suspense fallback={null}>
                        <SuggestedLink lists={lists} shop={s} />
                      </Suspense>
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

/** A field that waits for the QuickBooks lists. */
function Loading({ what, children }: { what: string; children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <p className="small" role="status">
          Loading {what}...
        </p>
      }
    >
      {children}
    </Suspense>
  );
}

async function ListsError({ lists }: { lists: Lists }) {
  const { error } = await lists;
  return error ? <div className="notice danger">{error}</div> : null;
}

/** The account for shipping deductions and the terms: picked from QuickBooks, else ids typed in. */
async function SettingFields({ lists: listsPromise, setting }: { lists: Lists; setting: BillLineSetting | null }) {
  const { lists } = await listsPromise;
  if (!lists) {
    return (
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
    );
  }
  const accountOptions: SearchOption[] = deductionOptions(lists.accounts, lists.items);
  const termsValue = setting?.termsId ? `${setting.termsId}::${setting.termsName ?? ""}` : "";
  // CDS books freight deductions to GL 5030 (CDS, 2026-11-16): suggested until an account is saved.
  const suggested5030 = !setting?.deduction ? lists.accounts.filter((a) => a.AcctNum?.trim() === "5030") : null;
  const deductionDefault = suggested5030?.length === 1 ? `account::${suggested5030[0].Id}::${suggested5030[0].FullyQualifiedName ?? suggested5030[0].Name}` : "";
  const net30 = defaultBillTerm(lists.terms);
  return (
    <div className="grid2">
      <div className="field">
        <label htmlFor="bill-target">Shipping deductions go to (account or item)</label>
        <FormSearchSelect
          id="bill-target"
          name="bill_target"
          options={accountOptions}
          defaultValue={deductionDefault}
          placeholder={setting?.deduction ? `Keep ${setting.deduction.name}` : "Type the account or item name"}
          limit={150}
        />
      </div>
      <div className="field">
        <label htmlFor="bill-terms">Terms</label>
        <select id="bill-terms" name="bill_terms" className="input" defaultValue={termsValue}>
          <option value="">{net30 ? `${net30.name} (the default)` : "The vendor's own terms"}</option>
          {lists.terms.map((t) => (
            <option key={t.Id} value={`${t.Id}::${t.Name}`}>
              {t.Name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** The QuickBooks vendor: picked from QuickBooks, else id and name typed in. */
async function VendorPicker({ lists: listsPromise }: { lists: Lists }) {
  const { lists } = await listsPromise;
  if (lists) {
    const vendorOptions: SearchOption[] = lists.vendors.map((v) => ({
      value: `${v.Id}::${v.DisplayName}`,
      label: v.DisplayName,
      hint: `QuickBooks id ${v.Id}${v.CompanyName && v.CompanyName !== v.DisplayName ? ` - ${v.CompanyName}` : ""}`,
    }));
    return (
      <div className="field">
        <label htmlFor="vmap-vendor">
          QuickBooks vendor <span className="req">*</span>
        </label>
        <FormSearchSelect id="vmap-vendor" name="qbo_vendor" options={vendorOptions} required placeholder="Type the vendor name as in QuickBooks" limit={150} />
      </div>
    );
  }
  return (
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
  );
}

async function suggestion(listsPromise: Lists, shopName: string) {
  const { lists } = await listsPromise;
  return lists ? suggestVendor(shopName, lists.vendors) : null;
}

async function Suggested({ lists, shopName }: { lists: Lists; shopName: string }) {
  const v = await suggestion(lists, shopName);
  return v ? <span className="small"> Suggested: {v.DisplayName}</span> : null;
}

async function SuggestedLink({ lists, shop }: { lists: Lists; shop: Shop }) {
  const v = await suggestion(lists, shop.display_name);
  return v ? (
    <ActionForm
      action={linkSuggestedVendor.bind(null, shop.id, v.Id, v.DisplayName)}
      submitLabel="Link"
      pendingLabel="..."
      submitClassName="btn btn-secondary btn-small"
    />
  ) : null;
}
