import { changedFields, isVisibleChange } from "@/components/cds-admin/audit";
import { one } from "@/components/cds-admin/server-utils";
import { dateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type Json = Record<string, unknown>;
type AuditRow = {
  id: number;
  at: string;
  table_name: string;
  row_id: string;
  action: "insert" | "update" | "delete";
  old_data: Json | null;
  new_data: Json | null;
  actor_id: string | null;
  actor_name: string | null;
  profiles: { full_name: string } | { full_name: string }[] | null;
};

const TABLE_LABEL: Record<string, string> = {
  shop_rates: "Shop rate",
  sell_prices: "Fleet price",
  customer_price_overrides: "Customer price",
  catalog_items: "Catalog item",
  affiliates: "Shop",
  affiliate_contacts: "Shop contact",
  profiles: "Login",
  customers: "Customer",
  customer_billing: "Customer billing",
  customer_locations: "Location",
  app_settings: "Setting",
  qbo_connection: "QuickBooks connection",
  qbo_customer_map: "QuickBooks customer link",
  qbo_item_map: "QuickBooks item link",
  qbo_measurement_map: "QuickBooks measurement item",
  customer_item_aliases: "Customer part number",
};

const ACTION_LABEL: Record<string, string> = { insert: "Added", update: "Changed", delete: "Removed" };
// Fields that best name a row, in order of preference.
const NAME_FIELDS = ["sku", "display_name", "full_name", "name", "code", "email", "key", "short_code", "billing_email", "qbo_display_name", "qbo_item_name", "customer_part_number", "company_name"];

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 40 ? `${s.slice(0, 39)}...` : s;
}

function summary(row: AuditRow): string {
  const data = row.new_data ?? row.old_data ?? {};
  if (row.action === "update" && row.old_data && row.new_data) {
    const oldData = row.old_data;
    const changed = changedFields(oldData, row.new_data);
    if (changed.length === 0) return "No visible change";
    const parts = changed.slice(0, 4).map((k) => `${k}: ${show(oldData[k])} → ${show(row.new_data![k])}`);
    return parts.join("; ") + (changed.length > 4 ? `; and ${changed.length - 4} more` : "");
  }
  const nameField = NAME_FIELDS.find((f) => data[f] !== undefined && data[f] !== null && data[f] !== "");
  const bits: string[] = [];
  if (nameField) bits.push(show(data[nameField]));
  if (data.amount !== undefined) bits.push(`amount ${show(data.amount)}`);
  if (data.effective_from !== undefined) bits.push(`from ${show(data.effective_from)}`);
  if (data.value !== undefined) bits.push(`value ${show(data.value)}`);
  return bits.join(", ") || row.row_id;
}

/**
 * Who made the change. The name is stored on the audit row, so a change by a login that was
 * deleted later still shows that person. Rows without a person were made by the system.
 * Rows written before names were stored (2026-10-15) by a login that is now deleted cannot
 * be told apart from system changes and show "System".
 */
function actor(row: AuditRow) {
  const current = one(row.profiles)?.full_name;
  if (current) return current;
  if (row.actor_name) {
    return (
      <>
        {row.actor_name} <span className="small">(deleted login)</span>
      </>
    );
  }
  return <span className="small">System</span>;
}

const SHOWN = 100;

export async function ChangeLogTab() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audit_log")
    .select("id, at, table_name, row_id, action, old_data, new_data, actor_id, actor_name, profiles(full_name)")
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    // Older rows that changed only updated_at are skipped, so read a few more than shown.
    .limit(300);
  const rows = ((data ?? []) as AuditRow[]).filter(isVisibleChange).slice(0, SHOWN);

  return (
    <>
      <p className="small">
        The latest 100 changes to prices, the catalog, shops, logins, customers, locations and settings.
      </p>
      {error && <div className="notice danger">Could not load the change log. Refresh the page to try again.</div>}
      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Action</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="small">
                  No changes recorded yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{dateTime(r.at)}</td>
                <td>{actor(r)}</td>
                <td>{TABLE_LABEL[r.table_name] ?? r.table_name}</td>
                <td>
                  <span className={r.action === "delete" ? "tag" : r.action === "insert" ? "tag green" : "tag blue"}>
                    {ACTION_LABEL[r.action] ?? r.action}
                  </span>
                </td>
                <td style={{ maxWidth: 520, wordBreak: "break-word" }}>{summary(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
