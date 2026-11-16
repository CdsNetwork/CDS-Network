import Link from "next/link";
import { createQuickBooksBill } from "@/app/cds/work-orders/[id]/actions";
import { dateTime, money } from "@/lib/format";
import type { BillState } from "@/lib/qbo/bill";
import { ActionForm } from "./ActionForm";

/**
 * The shop's bill in QuickBooks on the CDS work order page (M3): its number and total once
 * created, why it is waiting, or QuickBooks's reason with a Retry. Nothing for an order
 * that gets no bill (not completed yet, cancelled, CDS's own shop).
 */
export function ShopBillPanel({ woId, status, state, loadError }: { woId: string; status: string; state: BillState | null; loadError: boolean }) {
  if (loadError) {
    return (
      <section className="section">
        <h3>Shop bill</h3>
        <div className="notice danger">The shop bill details could not be loaded. Reload the page.</div>
      </section>
    );
  }
  if (!state || state.kind === "none") return null;

  if (state.kind === "not_set_up") {
    return (
      <section className="section">
        <h3>Shop bill</h3>
        <p className="small">
          QuickBooks bills are not set up yet.{" "}
          <Link className="link" href="/cds/admin?tab=quickbooks">
            Admin &gt; QuickBooks mappings
          </Link>
        </p>
      </section>
    );
  }

  if (state.kind === "created") {
    return (
      <section className="section">
        <h3>Shop bill</h3>
        <p>
          QuickBooks bill <b>{state.number ?? `id ${state.billId}`}</b>
          {state.total !== null ? ` (${money(state.total)})` : ""}
          {state.at ? <span className="small"> created {dateTime(state.at)}</span> : null}
        </p>
        {!state.division && <p className="small">No Division: no COGS division in QuickBooks matched this customer.</p>}
        {state.changedTotal !== null && (
          <div className="notice warning" role="status">
            The shop total is now {money(state.changedTotal)}. Change the bill in QuickBooks to match.
          </div>
        )}
        {status === "cancelled" && (
          <div className="notice warning">This order is cancelled. Void the bill in QuickBooks if it should not stand.</div>
        )}
      </section>
    );
  }

  if (state.kind === "creating") {
    return (
      <section className="section">
        <h3>Shop bill</h3>
        <p className="small">The bill is being created in QuickBooks. Refresh in a moment.</p>
      </section>
    );
  }

  const lastError = state.lastError;
  return (
    <section className="section">
      <h3>Shop bill</h3>
      {lastError && (
        <div className="notice danger" role="status">
          QuickBooks did not create the bill: {lastError}
        </div>
      )}
      {state.kind === "blocked" ? (
        <div className="notice warning" role="status">
          <b>The bill is created when these are done:</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {state.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p className="small">
            Bill {state.payload.DocNumber} to {state.payload.VendorRef.name ?? "the shop's vendor"} for {money(state.total)}
            {state.payload.DepartmentRef ? `, Division ${state.payload.DepartmentRef.name}` : ""}.
            {state.beforeSince && !lastError
              ? " This order was completed before QuickBooks bills were turned on: create the bill only if it is not in QuickBooks yet."
              : ""}
          </p>
          <ActionForm
            action={createQuickBooksBill.bind(null, woId)}
            submitLabel={lastError ? "Retry: create QuickBooks bill" : "Create QuickBooks bill"}
            pendingLabel="Creating bill..."
            buttonClass="btn btn-blue"
            confirmText={`Create the shop's bill in QuickBooks for ${money(state.total)}?`}
          />
        </>
      )}
    </section>
  );
}
