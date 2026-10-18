import { ActionForm } from "@/components/cds-admin/ActionForm";
import { DISCONNECT_QUICKBOOKS_CONFIRM } from "@/components/cds-admin/confirm";
import { dateTime } from "@/lib/format";
import { qboStatus, type QboStatus } from "@/lib/qbo/status";
import { createClient } from "@/lib/supabase/server";
import { saveSettings } from "./actions";
import { disconnectQuickBooks } from "./qbo-actions";

/** Messages for the result of the QuickBooks connect flow (?qbo=...). */
const QBO_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "QuickBooks is connected." },
  denied: { ok: false, text: "The connection was cancelled on the Intuit screen. Nothing was changed." },
  state: { ok: false, text: "The connection could not be verified (the link expired or was opened in another browser). Start again." },
  failed: { ok: false, text: "QuickBooks could not be connected. Try again; if it keeps failing, check the Intuit app settings." },
  not_configured: { ok: false, text: "QuickBooks is not configured on this server yet." },
};

export async function SettingsTab({ qboResult }: { qboResult?: string }) {
  const supabase = await createClient();
  const qbo = await qboStatus(supabase);
  const { data } = await supabase
    .from("app_settings")
    .select("value, updated_at, profiles(full_name)")
    .eq("key", "auto_dispatch_enabled")
    .maybeSingle();
  const enabled = data?.value === true;
  const by = (Array.isArray(data?.profiles) ? data?.profiles[0] : data?.profiles) as { full_name: string } | null | undefined;

  return (
    <>
    <QuickBooksSection status={qbo} result={qboResult ? QBO_RESULT[qboResult] : undefined} />
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
    </>
  );
}

function QuickBooksSection({ status, result }: { status: QboStatus; result?: { ok: boolean; text: string } }) {
  return (
    <div className="section">
      <h3>QuickBooks Online</h3>
      {result && (
        <div className={`notice${result.ok ? "" : " danger"}`} role="status">
          {result.text}
        </div>
      )}
      {status.error && <div className="notice danger">{status.error}</div>}
      {!status.configured ? (
        <p className="small">
          QuickBooks is not configured on this server. The Intuit app keys (QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT,
          QBO_REDIRECT_URI) must be set first.
        </p>
      ) : status.connected ? (
        <>
          <p>
            Connected to <b>{status.companyName ?? "a QuickBooks company"}</b>
            {status.environment === "sandbox" && <span className="tag">Sandbox</span>}
          </p>
          <p className="small">
            Connected {status.connectedAt ? dateTime(status.connectedAt) : ""}
            {status.connectedByName ? ` by ${status.connectedByName}` : ""}.
          </p>
          {status.astEnabled === false && (
            <div className="notice warning">
              Automated Sales Tax is not turned on in this QuickBooks company, so invoices will not get sales tax calculated.
              Turn on sales tax in QuickBooks (Taxes), then connect again.
            </div>
          )}
          <ActionForm
            action={disconnectQuickBooks}
            submitLabel="Disconnect QuickBooks"
            submitClassName="btn btn-secondary"
            pendingLabel="Disconnecting..."
            confirmText={DISCONNECT_QUICKBOOKS_CONFIRM}
          />
        </>
      ) : (
        <>
          {status.environment && status.environment !== status.serverEnvironment ? (
            <p className="small">
              The saved connection is for the {status.environment} company, but this server uses {status.serverEnvironment}. Connect
              again.
            </p>
          ) : (
            <p className="small">Not connected. Invoices cannot be created in QuickBooks until it is connected.</p>
          )}
          <p className="small">
            You will sign in to Intuit. Only a QuickBooks Primary Admin or Company Admin can approve the connection.
          </p>
          <a className="btn btn-blue" href="/cds/quickbooks/connect">
            Connect to QuickBooks
          </a>
        </>
      )}
    </div>
  );
}
