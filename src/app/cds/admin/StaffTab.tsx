import { ActionForm } from "@/components/cds-admin/ActionForm";
import { date } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { inviteStaff, setProfileActive } from "./actions";

type StaffRow = { id: string; full_name: string; email: string; active: boolean; created_at: string };

export async function StaffTab({ meId }: { meId: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, active, created_at")
    .eq("kind", "cds")
    .order("full_name");
  const staff = (data ?? []) as StaffRow[];

  return (
    <>
      <div className="section">
        <h3>Invite staff</h3>
        <p className="small" style={{ marginTop: -6 }}>
          The person gets an email with a link to set their password. Staff logins see every work order, price and shop.
        </p>
        <ActionForm action={inviteStaff} submitLabel="Send invite" pendingLabel="Sending..." resetOnSuccess>
          <div className="grid3">
            <div className="field">
              <label htmlFor="staff-name">
                Full name <span className="req">*</span>
              </label>
              <input className="input" id="staff-name" name="full_name" required autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="staff-email">
                Email <span className="req">*</span>
              </label>
              <input className="input" id="staff-email" name="email" type="email" required autoComplete="off" />
            </div>
          </div>
        </ActionForm>
      </div>

      {error && <div className="notice danger">Could not load staff. Refresh the page to try again.</div>}

      <div className="tablewrap" style={{ marginTop: 18 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Since</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.full_name}</b>
                  {p.id === meId && <span className="small"> (you)</span>}
                </td>
                <td>{p.email}</td>
                <td>{date(p.created_at)}</td>
                <td>{p.active ? <span className="tag green">Active</span> : <span className="tag">Inactive</span>}</td>
                <td>
                  {p.id !== meId && (
                    <ActionForm
                      key={`${p.id}-${p.active}`}
                      action={setProfileActive.bind(null, p.id, !p.active)}
                      submitLabel={p.active ? "Deactivate" : "Reactivate"}
                      pendingLabel="..."
                      submitClassName={`btn btn-small ${p.active ? "btn-danger" : "btn-secondary"}`}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
