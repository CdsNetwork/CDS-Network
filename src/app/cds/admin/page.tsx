import Link from "next/link";
import { requireCds } from "@/lib/auth";
import { ChangeLogTab } from "./ChangeLogTab";
import { CustomersTab } from "./CustomersTab";
import { LocationsTab } from "./LocationsTab";
import { SettingsTab } from "./SettingsTab";
import { ShopsTab } from "./ShopsTab";
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

export default async function AdminPage({ searchParams }: PageProps<"/cds/admin">) {
  const me = await requireCds();
  const sp = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "staff";
  const edit = typeof sp.edit === "string" ? sp.edit : undefined;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";

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
      {tab === "shops" && <ShopsTab edit={edit} />}
      {tab === "locations" && <LocationsTab edit={edit} q={q} />}
      {tab === "customers" && <CustomersTab edit={edit} />}
      {tab === "settings" && <SettingsTab />}
      {tab === "log" && <ChangeLogTab />}
    </>
  );
}
