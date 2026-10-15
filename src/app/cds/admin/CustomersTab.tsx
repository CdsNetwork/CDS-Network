import Link from "next/link";
import { ActionForm } from "@/components/cds-admin/ActionForm";
import { one } from "@/components/cds-admin/server-utils";
import { createClient } from "@/lib/supabase/server";
import { saveCustomer } from "./actions";
import { wrapCell } from "@/lib/format";

type Customer = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  customer_billing: { billing_email: string | null } | { billing_email: string | null }[] | null;
  customer_locations: { count: number }[] | null;
};

export async function CustomersTab({ edit }: { edit?: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, code, name, active, customer_billing(billing_email), customer_locations(count)")
    .order("name");
  const customers = (data ?? []) as Customer[];
  const editing = edit ? customers.find((c) => c.id === edit) : undefined;

  return (
    <>
      {editing ? (
        <div className="section">
          <div className="row between">
            <h3>Edit {editing.name}</h3>
            <Link className="btn btn-secondary btn-small" href="/cds/admin?tab=customers">
              Close
            </Link>
          </div>
          <ActionForm key={editing.id} action={saveCustomer.bind(null, editing.id)} submitLabel="Save customer">
            <CustomerFields customer={editing} />
          </ActionForm>
        </div>
      ) : (
        <div className="section">
          <h3>Add customer</h3>
          <ActionForm action={saveCustomer.bind(null, null)} submitLabel="Add customer" resetOnSuccess>
            <CustomerFields />
          </ActionForm>
        </div>
      )}

      {error && <div className="notice danger">Could not load customers. Refresh the page to try again.</div>}

      <div className="tablewrap" style={{ marginTop: 18 }}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Billing email</th>
              <th className="num">Locations</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr>
                <td colSpan={6} className="small">
                  No customers yet.
                </td>
              </tr>
            )}
            {customers.map((c) => (
              <tr key={c.id} style={c.active ? undefined : { opacity: 0.6 }}>
                <td className="nowrap">
                  <b>{c.code}</b>
                </td>
                <td>{c.name}</td>
                <td className={wrapCell(one(c.customer_billing)?.billing_email)}>{one(c.customer_billing)?.billing_email ?? <span className="small">Not set</span>}</td>
                <td className="num">{c.customer_locations?.[0]?.count ?? 0}</td>
                <td>{c.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}</td>
                <td>
                  <Link className="link small" href={`/cds/admin?tab=customers&edit=${c.id}`}>
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CustomerFields({ customer }: { customer?: Customer }) {
  const k = customer?.id ?? "new";
  return (
    <div className="grid3">
      <div className="field">
        <label htmlFor={`ccode-${k}`}>
          Code <span className="req">*</span>
        </label>
        <input className="input" id={`ccode-${k}`} name="code" required defaultValue={customer?.code ?? ""} placeholder="FLEETCO" />
      </div>
      <div className="field">
        <label htmlFor={`cname-${k}`}>
          Name <span className="req">*</span>
        </label>
        <input className="input" id={`cname-${k}`} name="name" required defaultValue={customer?.name ?? ""} />
      </div>
      <div className="field">
        <label htmlFor={`cbill-${k}`}>Billing email</label>
        <input
          className="input"
          id={`cbill-${k}`}
          name="billing_email"
          type="email"
          defaultValue={customer ? (one(customer.customer_billing)?.billing_email ?? "") : ""}
          placeholder="ap@fleet.example"
        />
      </div>
      {customer && (
        <div className="field">
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 500 }}>
            <input type="checkbox" name="active" defaultChecked={customer.active} /> Active
          </label>
        </div>
      )}
    </div>
  );
}
