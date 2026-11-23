import Link from "next/link";
import { approveShopBill, createQuickBooksBill } from "@/app/cds/work-orders/[id]/actions";
import { dateTime, money } from "@/lib/format";
import type { BillState, QboBillPayload } from "@/lib/qbo/bill";
import { ActionForm } from "./ActionForm";
import { SHOP_BILL_PENDING_LABEL } from "./util";

/**
 * The shop's bill in QuickBooks on the CDS work order page (M3): its number and total once
 * created, why it is waiting, the bill waiting for CDS's approval (AFF Bill Pnd Approval:
 * lines, amounts, deduction, bill number, then "Approve and send to QuickBooks"), or
 * QuickBooks's reason with a Retry. Nothing for an order that gets no bill (not completed
 * yet, cancelled, CDS's own shop with no vendor linked).
 */

/** The bill as it will be sent: one row per QuickBooks line (shop lines, then the deduction). */
function BillPreview({ payload, total }: { payload: QboBillPayload; total: number }) {
  return (
    <div className="tablewrap" style={{ margin: "8px 0" }}>
      <table>
        <thead>
          <tr>
            <th>Line</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {payload.Line.map((l, i) => (
            <tr key={i}>
              <td>{l.Description}</td>
              <td className="num money">{money(l.Amount)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <b>Total</b>
            </td>
            <td className="num money">
              <b>{money(total)}</b>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
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
          <Link className="link" href="/cds/admin?tab=bills">
            Admin &gt; Shop bills
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
          <b>Before the bill can be approved and sent:</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {state.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {state.kind === "pending_approval" && (
            <p>
              <span className="badge pending">{SHOP_BILL_PENDING_LABEL}</span>
            </p>
          )}
          <p className="small">
            Bill {state.payload.DocNumber} to {state.payload.VendorRef.name ?? "the shop's vendor"} for {money(state.total)}
            {state.payload.DepartmentRef ? `, Division ${state.payload.DepartmentRef.name}` : ""}.
            {state.beforeSince && !lastError
              ? state.beforeVendorLink
                ? " This in-house order was completed before CDS Inc (in-house) was linked to its QuickBooks vendor: send the bill only if it is not in QuickBooks yet."
                : " This order was completed before QuickBooks bills were turned on: send the bill only if it is not in QuickBooks yet."
              : ""}
          </p>
          <BillPreview payload={state.payload} total={state.total} />
          {state.kind === "pending_approval" ? (
            <>
              <p className="small">Check the lines (kits instead of loose parts); change them above if needed. A change after approval needs a new approval until the bill is in QuickBooks.</p>
              <ActionForm
                action={approveShopBill.bind(null, woId, state.total)}
                submitLabel="Approve and send to QuickBooks"
                pendingLabel="Sending bill..."
                buttonClass="btn btn-blue"
                confirmText={`Approve the shop's bill (${money(state.total)}) and send it to QuickBooks?`}
              />
            </>
          ) : (
            <>
              <p className="small">Approved {dateTime(state.approvedAt)}.</p>
              <ActionForm
                action={createQuickBooksBill.bind(null, woId)}
                submitLabel={lastError ? "Retry: create QuickBooks bill" : "Create QuickBooks bill"}
                pendingLabel="Creating bill..."
                buttonClass="btn btn-blue"
                confirmText={`Create the shop's bill in QuickBooks for ${money(state.total)}?`}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
