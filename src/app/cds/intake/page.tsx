import Link from "next/link";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { one } from "@/components/cds-admin/server-utils";
import { requireCds } from "@/lib/auth";
import { dateTime, FULFILLMENT_LABEL, woLabel, wrapCell } from "@/lib/format";
import { INTAKE_MAILBOX } from "@/lib/intake/config";
import type { ParsedEmail } from "@/lib/intake/types";
import { createClient } from "@/lib/supabase/server";
import { addSenderDomain, ignoreEmail, pasteEmail, removeSenderDomain, retryEmail } from "./actions";

type EmailRow = {
  id: string;
  received_at: string;
  from_address: string | null;
  from_header: string | null;
  subject: string | null;
  status: "new" | "parsed" | "failed" | "ignored" | "converted";
  source: string;
  confidence: number | null;
  parsed: ParsedEmail | null;
  error: string | null;
  work_order_id: string | null;
  work_orders: { wo_number: number } | { wo_number: number }[] | null;
};

const STATUS: Record<EmailRow["status"], { label: string; className: string }> = {
  new: { label: "New", className: "tag" },
  parsed: { label: "Needs CDS", className: "tag blue" },
  failed: { label: "Failed", className: "tag" },
  ignored: { label: "Not a request", className: "tag" },
  converted: { label: "Draft created", className: "tag green" },
};
const FILTERS = ["all", "parsed", "failed", "converted", "ignored"] as const;

function Confidence({ parsed }: { parsed: ParsedEmail | null }) {
  if (!parsed) return <span className="small">-</span>;
  const pct = Math.round(parsed.confidence * 100);
  const color = parsed.confidence_label === "high" ? "#3b6d12" : parsed.confidence_label === "medium" ? "#7a5200" : "#a1261d";
  return (
    <span className="nowrap" style={{ color, fontWeight: 700 }} title={parsed.llm.used ? `Read by ${parsed.llm.model}` : "Pattern matching only"}>
      {pct}% {parsed.confidence_label}
    </span>
  );
}

function Field({ label, value, source }: { label: string; value: string | null | undefined; source?: string }) {
  return (
    <div>
      <span className="small">{label}: </span>
      {value ? <b>{value}</b> : <span className="small">not found</span>}
      {value && source && source !== "none" && <span className="small"> ({source === "llm" ? "AI" : source === "regex" ? "pattern" : "location default"})</span>}
    </div>
  );
}

function Details({ p }: { p: ParsedEmail }) {
  const f = p.fields;
  return (
    <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <Field label="Customer" value={p.customer ? `${p.customer.name} (${p.customer.via.replace("_", " ")})` : p.customer_candidates.map((c) => c.name).join(" or ") || null} />
      <Field
        label="Location"
        value={
          p.location
            ? `${p.location.code} (${p.location.via.replace("_", " ")})`
            : p.location_candidates.length
              ? `one of ${p.location_candidates.map((c) => c.code).join(", ")}`
              : [f.location_number.value, f.location_name.value, f.location_address.value].filter(Boolean).join(", ") || null
        }
      />
      <Field label="Unit" value={f.unit_number.value} source={f.unit_number.source} />
      <Field label="PO" value={f.po_number.value} source={f.po_number.source} />
      {f.vin.value && <Field label="VIN" value={f.vin.value} source={f.vin.source} />}
      <Field label="Method" value={f.fulfillment.value ? FULFILLMENT_LABEL[f.fulfillment.value] ?? f.fulfillment.value : null} source={f.fulfillment.source} />
      <div>
        <span className="small">Items: </span>
        {p.items.length === 0 && <span className="small">none found</span>}
        {p.items.map((i, n) => (
          <div key={n} style={{ marginLeft: 10 }}>
            {i.qty} x {i.catalog_item_id ? <b>{i.sku}</b> : <span style={{ color: "#a1261d" }}>not matched</span>}{" "}
            <span className="small">
              {i.part_number ? `${i.part_number} ` : ""}
              {i.name ?? i.description}
            </span>
          </div>
        ))}
      </div>
      {f.notes.value && <Field label="Notes" value={f.notes.value} />}
      {p.warnings.length > 0 && (
        <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {p.warnings.map((w, n) => (
            <li key={n}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function IntakePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireCds();
  const { status: rawStatus } = await searchParams;
  const status = (FILTERS as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as (typeof FILTERS)[number]) : "all";
  const supabase = await createClient();

  let query = supabase
    .from("inbound_emails")
    .select("id, received_at, from_address, from_header, subject, status, source, confidence, parsed, error, work_order_id, work_orders!inbound_emails_work_order_id_fkey(wo_number)")
    .order("received_at", { ascending: false })
    .limit(100);
  if (status !== "all") query = query.eq("status", status);

  const countOf = (s: "parsed" | "failed") => supabase.from("inbound_emails").select("id", { count: "exact", head: true }).eq("status", s);
  const [emailsRes, customersRes, domainsRes, waitingRes, failedRes] = await Promise.all([
    query,
    supabase.from("customers").select("id, name").eq("active", true).order("name"),
    supabase.from("customer_email_domains").select("id, domain, customer_id, customers(name)").order("domain"),
    // Counted by the database: reading rows would stop at 1000.
    countOf("parsed"),
    countOf("failed"),
  ]);
  const emails = (emailsRes.data ?? []) as EmailRow[];
  const customers = (customersRes.data ?? []) as { id: string; name: string }[];
  const domains = (domainsRes.data ?? []) as unknown as { id: string; domain: string; customers: { name: string } | { name: string }[] | null }[];
  const waiting = waitingRes.count ?? 0;
  const failed = failedRes.count ?? 0;

  return (
    <>
      <div className="row between">
        <div className="title">
          <h1>Email Intake</h1>
          <p>
            Work request emails to {INTAKE_MAILBOX} are read into draft work orders. Every draft lands in Pending Review
            and is never dispatched until CDS checks it.
          </p>
        </div>
        <span className="pill">
          {waiting} need CDS · {failed} failed
        </span>
      </div>

      {emailsRes.error && <div className="notice danger">Could not load emails. Refresh the page to try again.</div>}

      <div className="row" style={{ marginTop: 12 }}>
        {FILTERS.map((f) => (
          <Link key={f} href={f === "all" ? "/cds/intake" : `/cds/intake?status=${f}`} className={`btn btn-small ${f === status ? "btn-primary" : "btn-secondary"}`}>
            {f === "all" ? "All" : STATUS[f].label}
          </Link>
        ))}
      </div>

      <div className="tablewrap" style={{ marginTop: 12 }}>
        <table className="wide">
          <thead>
            <tr>
              <th>Received</th>
              <th>From / Subject</th>
              <th>Status</th>
              <th>What was read</th>
              <th>Confidence</th>
              <th>Work order</th>
            </tr>
          </thead>
          <tbody>
            {emails.length === 0 && (
              <tr>
                <td colSpan={6} className="small">
                  No emails yet. Paste one below to try the intake.
                </td>
              </tr>
            )}
            {emails.map((e) => {
              const wo = one(e.work_orders);
              const s = STATUS[e.status];
              return (
                <tr key={e.id}>
                  <td className="nowrap">
                    {dateTime(e.received_at)}
                    <div className="small">{e.source === "paste" ? "Pasted" : "Inbox"}</div>
                  </td>
                  <td className={wrapCell(e.from_address, e.subject)} style={{ minWidth: 200 }}>
                    <div>{e.from_address ?? e.from_header}</div>
                    <div className="small">{e.subject || "(no subject)"}</div>
                  </td>
                  <td>
                    <span className={s.className} style={e.status === "failed" ? { background: "#fff1f0", color: "#a1261d" } : undefined}>
                      {s.label}
                    </span>
                    {e.error && (
                      <div className="small" style={{ maxWidth: 260, marginTop: 4 }}>
                        {e.error}
                      </div>
                    )}
                    {e.status === "ignored" && e.parsed?.ignore_reason && (
                      <div className="small" style={{ marginTop: 4 }}>
                        {e.parsed.ignore_reason}
                      </div>
                    )}
                  </td>
                  <td style={{ minWidth: 260 }}>{e.parsed ? <Details p={e.parsed} /> : <span className="small">Not read yet</span>}</td>
                  <td>
                    <Confidence parsed={e.parsed} />
                  </td>
                  <td>
                    {e.work_order_id ? (
                      <Link className="btn btn-secondary btn-small nowrap" href={`/cds/work-orders/${e.work_order_id}`}>
                        {wo ? woLabel(wo.wo_number) : "Open"}
                      </Link>
                    ) : (
                      <div style={{ display: "grid", gap: 6 }}>
                        {(e.status === "failed" || e.status === "parsed" || e.status === "new") && (
                          <ActionForm action={retryEmail.bind(null, e.id, false)} submitLabel="Retry" pendingLabel="Reading..." submitClassName="btn btn-secondary btn-small" />
                        )}
                        {e.status === "ignored" && (
                          <ActionForm
                            action={retryEmail.bind(null, e.id, true)}
                            submitLabel="Treat as request"
                            pendingLabel="Reading..."
                            submitClassName="btn btn-secondary btn-small"
                          />
                        )}
                        {e.status !== "ignored" && (
                          <ActionForm action={ignoreEmail.bind(null, e.id)} submitLabel="Not a request" pendingLabel="Saving..." submitClassName="btn btn-secondary btn-small" />
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid2">
        <div className="section">
          <h3>Paste an email</h3>
          <p className="small" style={{ marginTop: -6 }}>
            For testing, or when an email did not come in automatically. The same email pasted twice is processed once.
          </p>
          <ActionForm action={pasteEmail} submitLabel="Read email" pendingLabel="Reading..." resetOnSuccess>
            <div className="field">
              <label htmlFor="intake-from">From (sender email)</label>
              <input id="intake-from" className="input" name="from" required maxLength={500} placeholder="name@fleet.example.com" />
            </div>
            <div className="field">
              <label htmlFor="intake-subject">Subject</label>
              <input id="intake-subject" className="input" name="subject" maxLength={1000} />
            </div>
            <div className="field">
              <label htmlFor="intake-body">Email text</label>
              <textarea id="intake-body" name="body" required rows={10} />
            </div>
            <div className="field">
              <label htmlFor="intake-mid">Message ID (optional)</label>
              <input id="intake-mid" className="input" name="message_id" maxLength={998} placeholder="Leave empty unless you have it" />
            </div>
          </ActionForm>
        </div>

        <div className="section">
          <h3>Sender domains</h3>
          <p className="small" style={{ marginTop: -6 }}>
            Emails from these domains (and their subdomains) are matched to the customer. Without a domain the customer is
            matched by name in the email, with lower confidence.
          </p>
          <ActionForm action={addSenderDomain} submitLabel="Add domain" resetOnSuccess>
            <div className="field">
              <label htmlFor="intake-customer">Customer</label>
              <select id="intake-customer" name="customer_id" required defaultValue="">
                <option value="" disabled>
                  Choose a customer
                </option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="intake-domain">Domain</label>
              <input id="intake-domain" className="input" name="domain" required maxLength={253} placeholder="fleet.example.com" />
            </div>
          </ActionForm>
          <div className="tablewrap" style={{ marginTop: 12 }}>
            <table>
              <tbody>
                {domains.length === 0 && (
                  <tr>
                    <td className="small">No domains yet.</td>
                  </tr>
                )}
                {domains.map((d) => (
                  <tr key={d.id}>
                    <td className={wrapCell(d.domain)}>
                      <b>{d.domain}</b>
                    </td>
                    <td>{one(d.customers)?.name}</td>
                    <td>
                      <ActionForm action={removeSenderDomain.bind(null, d.id)} submitLabel="Remove" submitClassName="btn btn-secondary btn-small" pendingLabel="Removing..." />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
