import Link from "next/link";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { createClient } from "@/lib/supabase/server";
import { inviteShopLogin, saveShop, setProfileActive, setShopActive } from "./actions";

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
};
type Login = { id: string; full_name: string; email: string; active: boolean; affiliate_id: string };
type Contact = { affiliate_id: string; email: string };

const KIND_LABEL: Record<string, string> = {
  service_shop: "Service shop",
  parts_supplier: "Parts supplier",
  cds_owned: "CDS owned",
};

export async function ShopsTab({ edit }: { edit?: string }) {
  const supabase = await createClient();
  const [{ data: shopData, error }, { data: loginData }, { data: contactData }] = await Promise.all([
    supabase
      .from("affiliates")
      .select("id, short_code, display_name, kind, active, address_line1, city, region, postal_code, can_egr, can_oil_soaked, can_one_box, hours_note")
      .order("display_name"),
    supabase.from("profiles").select("id, full_name, email, active, affiliate_id").eq("kind", "shop").order("active", { ascending: false }),
    supabase.from("affiliate_contacts").select("affiliate_id, email").eq("receives_dispatch", true).order("email"),
  ]);
  const shops = (shopData ?? []) as Shop[];
  const logins = (loginData ?? []) as Login[];
  const contacts = (contactData ?? []) as Contact[];
  const loginsFor = (id: string) => logins.filter((l) => l.affiliate_id === id);
  const dispatchFor = (id: string) => contacts.find((c) => c.affiliate_id === id)?.email ?? "";

  const editing = edit === "new" ? null : shops.find((s) => s.id === edit);

  return (
    <>
      {editing ? (
        <ShopEditor shop={editing} dispatchEmail={dispatchFor(editing.id)} logins={loginsFor(editing.id)} />
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

      {error && <div className="notice danger">Could not load shops. Refresh the page to try again.</div>}

      <div className="tablewrap" style={{ marginTop: 18 }}>
        <table className="wide">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>City / Region</th>
              <th>Capabilities</th>
              <th>Login</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shops.length === 0 && (
              <tr>
                <td colSpan={8} className="small">
                  No shops yet.
                </td>
              </tr>
            )}
            {shops.map((s) => {
              const login = loginsFor(s.id).find((l) => l.active);
              return (
                <tr key={s.id} style={s.active ? undefined : { opacity: 0.6 }}>
                  <td>
                    <b>{s.short_code}</b>
                  </td>
                  <td>
                    {s.display_name}
                    {dispatchFor(s.id) && <div className="small">Dispatch: {dispatchFor(s.id)}</div>}
                  </td>
                  <td>{KIND_LABEL[s.kind] ?? s.kind}</td>
                  <td>{[s.city, s.region].filter(Boolean).join(", ") || "-"}</td>
                  <td>
                    <Capabilities shop={s} />
                  </td>
                  <td>{login ? login.email : <span className="small">No login</span>}</td>
                  <td>{s.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}</td>
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

function ShopEditor({ shop, dispatchEmail, logins }: { shop: Shop; dispatchEmail: string; logins: Login[] }) {
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
            <div key={l.id} className="summaryrow" style={{ alignItems: "center" }}>
              <span>
                <b>{l.full_name}</b> <span className="small">{l.email}</span>{" "}
                {l.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}
              </span>
              <ActionForm
                key={`${l.id}-${l.active}`}
                action={setProfileActive.bind(null, l.id, !l.active)}
                submitLabel={l.active ? "Deactivate" : "Reactivate"}
                pendingLabel="..."
                submitClassName={`btn btn-small ${l.active ? "btn-danger" : "btn-secondary"}`}
              />
            </div>
          ))}
          {!activeLogin && (
            <div style={{ marginTop: 10 }}>
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
          {Object.entries(KIND_LABEL).map(([value, label]) => (
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
