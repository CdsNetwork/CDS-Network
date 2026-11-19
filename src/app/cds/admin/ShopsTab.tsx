import Link from "next/link";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import styles from "@/components/cds-admin/cds-admin.module.css";
import { createClient } from "@/lib/supabase/server";
import {
  createShopUsernameLogin,
  inviteShopLogin,
  saveShop,
  sendShopPasswordLink,
  setProfileActive,
  setShopActive,
  setShopEmails,
  setShopRecoveryEmail,
} from "./actions";
import { suggestUsername, USERNAME_LOGINS_OFF } from "@/lib/shop-login";
import { usernameLoginsOn } from "@/lib/shop-login-setting";
import { wrapCell } from "@/lib/format";
import { fetchAllSettled } from "@/lib/supabase/fetch-all";

export type Shop = {
  id: string;
  short_code: string;
  display_name: string;
  kind: string;
  active: boolean;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  can_egr: boolean | null;
  can_oil_soaked: boolean | null;
  can_one_box: boolean | null;
  hours_note: string | null;
  /** CDS's own in-house shop: never emailed. */
  is_in_house: boolean;
  /** "Email this shop about its jobs" (20261120200000_shop_emails.sql). */
  shop_emails_enabled: boolean;
};
type ShopRow = Shop & { customer_locations: { count: number }[] | null };
export type ShopFilters = { q: string; kind: string; status: string };
type Login = {
  id: string;
  full_name: string;
  email: string;
  active: boolean;
  affiliate_id: string;
  /** Username logins (shops whose locations share an email): email is an internal address. */
  username: string | null;
  recovery_email: string | null;
};
type Contact = { affiliate_id: string; email: string };

export const SHOP_KIND_LABEL: Record<string, string> = {
  service_shop: "Service shop",
  parts_supplier: "Parts supplier",
  cds_owned: "CDS owned",
};

export async function ShopsTab({ edit, filters }: { edit?: string; filters: ShopFilters }) {
  const supabase = await createClient();
  const [{ data: shopData, error }, { data: loginData }, { data: contactData }, usernameLogins] = await Promise.all([
    supabase
      .from("affiliates")
      .select(
        "id, short_code, display_name, kind, active, address_line1, city, region, postal_code, can_egr, can_oil_soaked, can_one_box, hours_note, is_in_house, shop_emails_enabled, customer_locations(count)",
      )
      .order("display_name"),
    // Logins and contacts grow with every shop: read in pages past the 1000 row cap.
    fetchAllSettled((from, to) =>
      supabase
        .from("profiles")
        .select("id, full_name, email, active, affiliate_id, username, recovery_email")
        .eq("kind", "shop")
        .order("active", { ascending: false })
        .order("id")
        .range(from, to),
    ),
    fetchAllSettled((from, to) =>
      supabase.from("affiliate_contacts").select("affiliate_id, email").eq("receives_dispatch", true).order("email").order("id").range(from, to),
    ),
    // Off until CDS turns it on (app_settings shop_username_logins).
    usernameLoginsOn(supabase),
  ]);
  const shops = (shopData ?? []) as ShopRow[];
  const logins = (loginData ?? []) as Login[];
  const contacts = (contactData ?? []) as Contact[];
  const loginsFor = (id: string) => logins.filter((l) => l.affiliate_id === id);
  const dispatchFor = (id: string) => contacts.find((c) => c.affiliate_id === id)?.email ?? "";
  const emailsFor = (id: string) => contacts.filter((c) => c.affiliate_id === id).map((c) => c.email);

  const editing = edit === "new" ? null : shops.find((s) => s.id === edit);
  const locationCount = (s: ShopRow) => s.customer_locations?.[0]?.count ?? 0;

  // Every word must match the code, name, city, state or an email of the shop.
  const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = shops.filter((s) => {
    if (filters.kind && s.kind !== filters.kind) return false;
    if (filters.status === "active" && !s.active) return false;
    if (filters.status === "inactive" && s.active) return false;
    if (!words.length) return true;
    const emails = [
      ...contacts.filter((c) => c.affiliate_id === s.id).map((c) => c.email),
      ...loginsFor(s.id).flatMap((l) => (l.username ? [l.username, l.recovery_email ?? ""] : [l.email])),
    ];
    const text = [s.short_code, s.display_name, s.city ?? "", s.region ?? "", ...emails].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const filtered = Boolean(filters.q || filters.kind || filters.status);

  return (
    <>
      {editing ? (
        <ShopEditor
          shop={editing}
          dispatchEmail={dispatchFor(editing.id)}
          dispatchEmails={emailsFor(editing.id)}
          logins={loginsFor(editing.id)}
          usernameLogins={usernameLogins}
        />
      ) : (
        <details className="section" open={edit === "new"}>
          <summary style={{ cursor: "pointer", fontWeight: 750 }}>+ Add shop</summary>
          <div style={{ marginTop: 14 }}>
            <ActionForm action={saveShop.bind(null, null)} submitLabel="Add shop" resetOnSuccess>
              <ShopFields />
            </ActionForm>
          </div>
        </details>
      )}

      <form className={styles.filters} method="get" action="/cds/admin">
        <input type="hidden" name="tab" value="shops" />
        <div className={styles.grow}>
          <label htmlFor="shop-q">Search</label>
          <input className="input" id="shop-q" type="search" name="q" defaultValue={filters.q} placeholder="Code, name, city or email" />
        </div>
        <div className={styles.fixed}>
          <label htmlFor="shop-kind">Type</label>
          <select id="shop-kind" name="kind" defaultValue={filters.kind}>
            <option value="">Any type</option>
            {Object.entries(SHOP_KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.fixed}>
          <label htmlFor="shop-status">Status</label>
          <select id="shop-status" name="status" defaultValue={filters.status}>
            <option value="">Active and inactive</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div className={styles.filterActions}>
          <button className="btn btn-secondary" type="submit">
            Search
          </button>
          {filtered && (
            <Link className="link small" href="/cds/admin?tab=shops">
              Clear
            </Link>
          )}
        </div>
      </form>
      <p className="small" role="status">
        {shown.length} of {shops.length} shops
      </p>

      {error && <div className="notice danger">Could not load shops. Refresh the page to try again.</div>}

      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>City / Region</th>
              <th>Capabilities</th>
              <th className="num">Locations</th>
              <th>Login</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="small">
                  {shops.length === 0 ? "No shops yet." : "No shops match this search."}
                </td>
              </tr>
            )}
            {shown.map((s) => {
              const login = loginsFor(s.id).find((l) => l.active);
              return (
                <tr key={s.id} style={s.active ? undefined : { opacity: 0.6 }}>
                  <td className="nowrap">
                    <b>{s.short_code}</b>
                  </td>
                  <td>
                    {s.display_name}
                    {dispatchFor(s.id) && <div className="small">Dispatch: {dispatchFor(s.id)}</div>}
                  </td>
                  <td>{SHOP_KIND_LABEL[s.kind] ?? s.kind}</td>
                  <td>{[s.city, s.region].filter(Boolean).join(", ") || "-"}</td>
                  <td>
                    <Capabilities shop={s} />
                  </td>
                  <td className="num">
                    {locationCount(s) > 0 ? (
                      <Link className="link" href={`/cds/admin?tab=locations&shop=${s.id}`} title="Locations with this default shop">
                        {locationCount(s)}
                      </Link>
                    ) : (
                      <span className="small">0</span>
                    )}
                  </td>
                  <td className={wrapCell(login ? (login.username ?? login.email) : undefined)}>
                    {!login ? (
                      <span className="small">No login</span>
                    ) : login.username ? (
                      <>
                        {login.username}
                        <div className="small">Recovery: {login.recovery_email}</div>
                      </>
                    ) : (
                      login.email
                    )}
                  </td>
                  <td>
                    {s.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}
                    {s.shop_emails_enabled && (
                      <div>
                        <span className="tag blue" title="This shop gets emails about its jobs">
                          Emails on
                        </span>
                      </div>
                    )}
                  </td>
                  <td>
                    <Link className="link small" href={`/cds/admin?tab=shops&edit=${s.id}`}>
                      Edit
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Capabilities({ shop }: { shop: Shop }) {
  const caps: [string, boolean | null][] = [
    ["EGR", shop.can_egr],
    ["Oil soaked", shop.can_oil_soaked],
    ["One box", shop.can_one_box],
  ];
  return (
    <div className="row" style={{ gap: 4 }}>
      {caps.map(([label, value]) => (
        <span key={label} className={value ? "tag green" : "tag"} title={value === null ? "Not known" : value ? "Yes" : "No"}>
          {label} {value === null ? "?" : value ? "yes" : "no"}
        </span>
      ))}
    </div>
  );
}

function ShopEditor({
  shop,
  dispatchEmail,
  dispatchEmails,
  logins,
  usernameLogins,
}: {
  shop: Shop;
  dispatchEmail: string;
  /** Every contact marked to receive dispatch emails: the shop emails go to all of them. */
  dispatchEmails: string[];
  logins: Login[];
  /** The shop_username_logins switch: off hides creating username logins and their password links. */
  usernameLogins: boolean;
}) {
  const activeLogin = logins.find((l) => l.active);
  return (
    <div className="section">
      <div className="row between">
        <h3>
          {shop.display_name} ({shop.short_code})
        </h3>
        <Link className="btn btn-secondary btn-small" href="/cds/admin?tab=shops">
          Close
        </Link>
      </div>
      <ActionForm key={shop.id} action={saveShop.bind(null, shop.id)} submitLabel="Save shop">
        <ShopFields shop={shop} dispatchEmail={dispatchEmail} />
      </ActionForm>

      <div className="grid2" style={{ marginTop: 18 }}>
        <div className="summarybox">
          <b>Shop login</b>
          <p className="small">One login per shop. The shop sees only its own released jobs and its pay, never customer prices.</p>
          {logins.map((l) => (
            <div key={l.id} style={{ marginBottom: 10 }}>
              <div className="summaryrow" style={{ alignItems: "center" }}>
                <span>
                  {l.username ? (
                    <>
                      <span className="small">Username</span> <b>{l.username}</b>
                    </>
                  ) : (
                    <>
                      <b>{l.full_name}</b> <span className="small">{l.email}</span>
                    </>
                  )}{" "}
                  {l.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  {l.username && l.active && usernameLogins && (
                    <ActionForm
                      action={sendShopPasswordLink.bind(null, l.id)}
                      submitLabel="Email password link"
                      pendingLabel="Sending..."
                      submitClassName="btn btn-small btn-secondary"
                      confirmText={`Email a link to set a new password for ${l.username} to ${l.recovery_email}?`}
                    />
                  )}
                  <ActionForm
                    key={`${l.id}-${l.active}`}
                    action={setProfileActive.bind(null, l.id, !l.active)}
                    submitLabel={l.active ? "Deactivate" : "Reactivate"}
                    pendingLabel="..."
                    submitClassName={`btn btn-small ${l.active ? "btn-danger" : "btn-secondary"}`}
                  />
                </span>
              </div>
              {l.username && !usernameLogins && <p className="small">{USERNAME_LOGINS_OFF}</p>}
              {l.username && (
                <ActionForm
                  key={`${l.id}-${l.recovery_email}`}
                  action={setShopRecoveryEmail.bind(null, l.id)}
                  submitLabel="Save"
                  submitClassName="btn btn-small btn-secondary"
                  inline
                >
                  <label className="small" htmlFor={`recovery-${l.id}`} style={{ alignSelf: "center", whiteSpace: "nowrap" }}>
                    Recovery email
                  </label>
                  <input
                    className="input"
                    id={`recovery-${l.id}`}
                    name="recovery_email"
                    type="email"
                    required
                    autoComplete="off"
                    defaultValue={l.recovery_email ?? ""}
                  />
                </ActionForm>
              )}
            </div>
          ))}
          {!activeLogin && (
            <div style={{ marginTop: 10 }}>
              {usernameLogins && (
                <>
                  <b className="small">Create login with username</b>
                  <p className="small" style={{ marginTop: 2 }}>
                    For shops whose locations share one email. The shop signs in with the username. The portal emails a link to
                    set the password to the recovery email, which several locations may share. CDS never sees the password.
                  </p>
                  <ActionForm
                    action={createShopUsernameLogin.bind(null, shop.id)}
                    submitLabel="Create login"
                    pendingLabel="Creating..."
                    resetOnSuccess
                  >
                    <div className="field">
                      <label htmlFor="login-username">
                        Username <span className="req">*</span>
                      </label>
                      <input
                        className="input"
                        id="login-username"
                        name="username"
                        required
                        minLength={3}
                        maxLength={60}
                        autoComplete="off"
                        defaultValue={suggestUsername(shop.display_name)}
                      />
                      <p className="small" style={{ margin: "4px 0 0" }}>Letters, digits, spaces, dots, dashes and underscores.</p>
                    </div>
                    <div className="field">
                      <label htmlFor="login-recovery">
                        Recovery email <span className="req">*</span>
                      </label>
                      <input className="input" id="login-recovery" name="recovery_email" type="email" required autoComplete="off" defaultValue={dispatchEmail} />
                    </div>
                  </ActionForm>
                  <b className="small" style={{ display: "block", marginTop: 14 }}>
                    Or invite with the shop&apos;s own email
                  </b>
                </>
              )}
              <ActionForm action={inviteShopLogin.bind(null, shop.id)} submitLabel="Invite shop login" pendingLabel="Sending..." resetOnSuccess>
                <div className="field">
                  <label htmlFor="login-name">
                    Contact name <span className="req">*</span>
                  </label>
                  <input className="input" id="login-name" name="full_name" required autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="login-email">
                    Login email <span className="req">*</span>
                  </label>
                  <input className="input" id="login-email" name="email" type="email" required autoComplete="off" defaultValue={dispatchEmail} />
                </div>
              </ActionForm>
            </div>
          )}
        </div>
        <ShopEmails shop={shop} emails={dispatchEmails} />
        <div className="summarybox">
          <b>Shop status</b>
          <p className="small">
            {shop.active
              ? "Active shops can be chosen for dispatch. Deactivating hides all jobs from the shop's login."
              : "This shop is inactive: it cannot receive work and its login sees nothing."}
          </p>
          <ActionForm
            key={`${shop.id}-${shop.active}`}
            action={setShopActive.bind(null, shop.id, !shop.active)}
            submitLabel={shop.active ? "Deactivate shop" : "Activate shop"}
            submitClassName={`btn btn-small ${shop.active ? "btn-danger" : "btn-primary"}`}
          />
        </div>
      </div>
    </div>
  );
}

/** "Email this shop about its jobs" (Sarah, CDS, 2026-11-19). */
function ShopEmails({ shop, emails }: { shop: Shop; emails: string[] }) {
  if (shop.is_in_house) {
    return (
      <div className="summarybox">
        <b>Emails to this shop</b>
        <p className="small">CDS&apos;s in-house shop is never emailed about its jobs.</p>
      </div>
    );
  }
  const on = shop.shop_emails_enabled;
  return (
    <div className="summarybox">
      <b>Email this shop about its jobs</b>
      <p className="small">
        {on ? "On" : "Off"}. When on, the portal emails the shop when CDS sends it a job, decides its extra work, adds a note it can see or
        changes its services or parts, and reminds it when a job is not accepted, not updated or not completed in time (weekdays only). No
        prices are ever in these emails.
      </p>
      {emails.length ? (
        <p className="small">Goes to: {emails.join(", ")}</p>
      ) : (
        <p className="small">
          <b>No dispatch email for this shop:</b> nothing is sent until one is saved above.
        </p>
      )}
      <ActionForm
        key={`${shop.id}-emails-${on}`}
        action={setShopEmails.bind(null, shop.id, !on)}
        submitLabel={on ? "Turn emails off" : "Turn emails on"}
        submitClassName={`btn btn-small ${on ? "btn-secondary" : "btn-primary"}`}
      />
    </div>
  );
}

function YesNo({ name, label, value }: { name: string; label: string; value: boolean | null | undefined }) {
  return (
    <div className="field">
      <label htmlFor={`${name}-f`}>{label}</label>
      <select id={`${name}-f`} name={name} defaultValue={value === true ? "true" : value === false ? "false" : ""}>
        <option value="">Not known</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </div>
  );
}

function ShopFields({ shop, dispatchEmail }: { shop?: Shop; dispatchEmail?: string }) {
  const k = shop?.id ?? "new";
  return (
    <div className="grid3">
      <div className="field">
        <label htmlFor={`code-${k}`}>
          Short code <span className="req">*</span>
        </label>
        <input className="input" id={`code-${k}`} name="short_code" required defaultValue={shop?.short_code ?? ""} placeholder="DAL" />
      </div>
      <div className="field">
        <label htmlFor={`name-${k}`}>
          Name <span className="req">*</span>
        </label>
        <input className="input" id={`name-${k}`} name="display_name" required defaultValue={shop?.display_name ?? ""} />
      </div>
      <div className="field">
        <label htmlFor={`kind-${k}`}>Type</label>
        <select id={`kind-${k}`} name="kind" defaultValue={shop?.kind ?? "service_shop"}>
          {Object.entries(SHOP_KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`addr-${k}`}>Address</label>
        <input className="input" id={`addr-${k}`} name="address_line1" defaultValue={shop?.address_line1 ?? ""} />
      </div>
      <div className="field">
        <label htmlFor={`city-${k}`}>City</label>
        <input className="input" id={`city-${k}`} name="city" defaultValue={shop?.city ?? ""} />
      </div>
      <div className="grid2" style={{ gap: 10 }}>
        <div className="field">
          <label htmlFor={`region-${k}`}>State</label>
          <input className="input" id={`region-${k}`} name="region" maxLength={3} defaultValue={shop?.region ?? ""} placeholder="TX" />
        </div>
        <div className="field">
          <label htmlFor={`zip-${k}`}>ZIP</label>
          <input className="input" id={`zip-${k}`} name="postal_code" defaultValue={shop?.postal_code ?? ""} />
        </div>
      </div>
      <YesNo name="can_egr" label="EGR coolers" value={shop?.can_egr} />
      <YesNo name="can_oil_soaked" label="Oil soaked filters" value={shop?.can_oil_soaked} />
      <YesNo name="can_one_box" label="One box units" value={shop?.can_one_box} />
      <div className="field">
        <label htmlFor={`hours-${k}`}>Hours note</label>
        <input className="input" id={`hours-${k}`} name="hours_note" defaultValue={shop?.hours_note ?? ""} placeholder="Mon to Fri, 7:00 AM to 5:00 PM" />
      </div>
      <div className="field">
        <label htmlFor={`dispatch-${k}`}>Dispatch email</label>
        <input className="input" id={`dispatch-${k}`} name="dispatch_email" type="email" defaultValue={dispatchEmail ?? ""} placeholder="dispatch@shop.example" />
      </div>
    </div>
  );
}
