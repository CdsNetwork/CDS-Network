import Link from "next/link";
import { requireCds } from "@/lib/auth";
import { ChangeLogTab } from "./ChangeLogTab";
import { CustomersTab } from "./CustomersTab";
import { LocationsTab } from "./LocationsTab";
import { SettingsTab } from "./SettingsTab";
import { SHOP_KIND_LABEL, ShopsTab } from "./ShopsTab";
import { FULFILLMENT_LABEL } from "@/lib/format";
import { StaffTab } from "./StaffTab";

const TABS = [
  { key: "staff", label: "Staff" },
  { key: "shops", label: "Shops" },
  { key: "locations", label: "Locations" },
  { key: "customers", label: "Customers" },
  { key: "settings", label: "Settings" },
  { key: "log", label: "Change log" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminPage({ searchParams }: PageProps<"/cds/admin">) {
  const me = await requireCds();
  const sp = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "staff";
  const edit = typeof sp.edit === "string" ? sp.edit : undefined;
  const str = (key: string) => (typeof sp[key] === "string" ? (sp[key] as string).trim() : "");
  const id = (key: string, extra: string[] = []) => {
    const v = str(key);
    return UUID.test(v) || extra.includes(v) ? v : "";
  };
  const q = str("q").slice(0, 200);
  const page = Math.min(Math.max(1, Number.parseInt(str("page"), 10) || 1), 10_000);
  const kind = str("kind");
  const status = str("status");
  const fulfillment = str("fulfillment");

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Admin</h1>
          <p>Staff logins, network shops, customer locations, customers, portal settings and the change log.</p>
        </div>
      </div>

      <nav className="toolbar" aria-label="Admin sections" style={{ marginTop: 18 }}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/cds/admin?tab=${t.key}`}
            className={`btn btn-small ${t.key === tab ? "btn-blue" : "btn-secondary"}`}
            aria-current={t.key === tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "staff" && <StaffTab meId={me.id} />}
      {tab === "shops" && (
        <ShopsTab
          edit={edit}
          filters={{
            q,
            kind: Object.hasOwn(SHOP_KIND_LABEL, kind) ? kind : "",
            status: status === "active" || status === "inactive" ? status : "",
          }}
        />
      )}
      {tab === "locations" && (
        <LocationsTab
          edit={edit}
          filters={{
            q,
            customer: id("customer"),
            shop: id("shop", ["none"]),
            fulfillment: Object.hasOwn(FULFILLMENT_LABEL, fulfillment) ? fulfillment : "",
            page,
          }}
        />
      )}
      {tab === "customers" && <CustomersTab edit={edit} />}
      {tab === "settings" && <SettingsTab />}
      {tab === "log" && <ChangeLogTab />}
    </>
  );
}
