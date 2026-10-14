import { ActionForm } from "@/components/cds-admin/ActionForm";
import { dateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { saveSettings } from "./actions";

export async function SettingsTab() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("app_settings")
    .select("value, updated_at, profiles(full_name)")
    .eq("key", "auto_dispatch_enabled")
    .maybeSingle();
  const enabled = data?.value === true;
  const by = (Array.isArray(data?.profiles) ? data?.profiles[0] : data?.profiles) as { full_name: string } | null | undefined;

  return (
    <div className="section">
      <h3>Dispatch</h3>
      <div className="notice warning">
        Automatic dispatch is not built yet. Every new work order is reviewed by CDS staff before it goes to a shop,
        whatever this setting says.
      </div>
      <ActionForm key={String(enabled)} action={saveSettings} submitLabel="Save settings">
        <div className="field">
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "var(--ink)" }}>
            <input type="checkbox" name="auto_dispatch_enabled" defaultChecked={enabled} />
            Automatically dispatch routine work orders to the location&apos;s default shop
          </label>
        </div>
      </ActionForm>
      {data?.updated_at && (
        <p className="small">
          Last changed {dateTime(data.updated_at)}
          {by?.full_name ? ` by ${by.full_name}` : ""}.
        </p>
      )}
    </div>
  );
}
