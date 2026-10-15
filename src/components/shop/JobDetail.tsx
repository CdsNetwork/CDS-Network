import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import {
  ATTACHMENT_CATEGORY_LABEL,
  COMPONENT_RESULT_LABEL,
  DIRECTION_LABEL,
  FULFILLMENT_LABEL,
  PICKUP_WINDOWS,
  SHIP_STATUS_LABEL,
  SHIPMENT_STATUS_LABEL,
  date,
  money,
  pickupWindowLabel,
  woLabel,
} from "@/lib/format";
import {
  acceptJob,
  addComponent,
  addPart,
  completeJob,
  declineJob,
  deleteComponent,
  removePart,
  requestAuthorization,
  saveComponent,
  setProgress,
  setShipStatus,
} from "@/app/shop/actions";
import type { JobDetailData } from "@/app/shop/data";
import { ActionButton, ActionForm } from "./ActionForm";
import { AttachmentForm } from "./AttachmentForm";
import { AuthRequestForm } from "./AuthRequestForm";
import { ComponentCard } from "./ComponentCard";
import { DeclineJob } from "./DeclineJob";
import styles from "./shop.module.css";
import { EDITABLE_STATUSES, componentLabel, type ComponentRow, type LineRow, type QueueTab } from "./types";

const ORIGIN_LABEL: Record<LineRow["origin"], string> = {
  cds_order: "Ordered by CDS",
  auth_request: "Approved extra work",
  shop_added: "Added by your shop",
};

const AUTH_STATUS_LABEL: Record<string, string> = {
  pending: "Pending CDS Approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const qtyText = (n: number) => String(n);

export function JobDetail({ data, tab }: { data: JobDetailData; tab: QueueTab }) {
  const { job, lines, components, authRequests, attachments, shipments } = data;
  const id = job.id;
  const editable = EDITABLE_STATUSES.includes(job.status);
  const awaiting = job.status === "awaiting_acceptance";
  const isPickup = job.fulfillment === "pickup";
  const isShipping = job.fulfillment === "shipping";
  const canUpload = editable || job.status === "completed";
  const canShipStatus = isShipping && ["accepted", "in_process", "completed"].includes(job.status);

  const settlement = lines.reduce((sum, l) => sum + (l.shop_unit_rate ?? 0) * l.qty, 0);
  const missingRate = lines.some((l) => l.shop_unit_rate === null);
  const photoCount = (componentId: string) => attachments.filter((a) => a.component_id === componentId).length;
  const componentOptions = components.map((c) => ({ id: c.id, label: componentLabel(c) }));
  const componentName = new Map(components.map((c) => [c.id, componentLabel(c)]));

  return (
    <div>
      <Link href={`/shop?tab=${tab}`} className={`link ${styles.back}`}>
        ← Back to queue
      </Link>

      {/* ------------------------------------------------ hero */}
      <div className="hero">
        <div className="small" style={{ fontWeight: 800, letterSpacing: "0.05em" }}>
          CDS NETWORK WORK ORDER
        </div>
        <h2>
          {woLabel(job.wo_number)} • {job.customer_name} - {job.location_label}
        </h2>
        <div>
          Unit {job.unit_number} • PO {job.po_number || "-"}
        </div>
        {job.site_address && <div className="small" style={{ marginTop: 4 }}>{job.site_address}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          {isShipping ? (
            <span className="tag blue">📦 Shipping</span>
          ) : isPickup ? (
            <span className="tag green">🚚 Pickup / Delivery</span>
          ) : (
            <span className="tag">{FULFILLMENT_LABEL[job.fulfillment]}</span>
          )}
          <StatusBadge status={job.status} shop />
        </div>

        {isShipping && (
          <div className="notice" style={{ background: "#fff" }}>
            <strong>LOGISTICS: SHIPPING</strong>
            <div>Do not schedule a local pickup. Use the CDS-provided shipping label(s) for this job.</div>
            {shipments.length === 0 && <p className="small">CDS has not added a shipment yet.</p>}
            {shipments.map((s) => (
              <div key={s.id} className="routebox" style={{ marginTop: 10 }}>
                <div className="row between">
                  <strong>{DIRECTION_LABEL[s.direction] ?? s.direction}</strong>
                  <span className="pill">{SHIPMENT_STATUS_LABEL[s.status] ?? s.status}</span>
                </div>
                <div className="small" style={{ marginTop: 4 }}>
                  {s.carrier ?? "Carrier not set"}
                </div>
                <div className={styles.tracking}>{s.tracking_number || "Tracking number not added yet"}</div>
              </div>
            ))}
            <p className="small" style={{ marginBottom: 0 }}>Labels: Milestone 2</p>
          </div>
        )}
        {isPickup && (
          <div className="notice" style={{ background: "#fff" }}>
            <strong>LOGISTICS: AFFILIATE PICKUP</strong>
            <div>Affiliate is responsible for pickup from the customer location.</div>
          </div>
        )}
        {job.status === "cancelled" && <div className="notice danger">CDS cancelled this job. No further work is needed.</div>}
      </div>

      {/* ------------------------------------------------ acceptance + settlement */}
      <div className="grid2">
        <section className="section" style={{ marginTop: 0 }}>
          <h3>Job acceptance</h3>
          <div className="routebox">
            <div className="small">Requested work</div>
            <div style={{ marginBottom: 8, whiteSpace: "pre-wrap" }}>{job.requested_work}</div>
            <div className="small">Fulfillment</div>
            <div>{isShipping ? "Carrier shipment" : isPickup ? "Affiliate pickup / local delivery" : FULFILLMENT_LABEL[job.fulfillment]}</div>
          </div>

          {awaiting && (
            <div style={{ marginTop: 12 }}>
              <ActionForm action={acceptJob.bind(null, id)} submitLabel="Accept Work" pendingLabel="Accepting..." submitClass="btn btn-primary">
                {isPickup && (
                  <div className="field">
                    <label htmlFor="pickup-window">
                      Pickup ETA / Window <span className="req">*</span>
                    </label>
                    <select id="pickup-window" name="pickup_window" required defaultValue="">
                      <option value="">Select pickup window...</option>
                      {PICKUP_WINDOWS.map((w) => (
                        <option key={w.value} value={w.value}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </ActionForm>
            </div>
          )}

          {isPickup && job.pickup_window && !awaiting && (
            <div className="notice">
              <strong>Pickup estimate:</strong> {pickupWindowLabel(job.pickup_window)}
            </div>
          )}

          {(job.status === "accepted" || job.status === "picked_up") && (
            <div className="row" style={{ marginTop: 12, alignItems: "flex-start" }}>
              {isPickup && job.status === "accepted" && (
                <ActionForm action={setProgress.bind(null, id)} submitLabel="Picked Up" submitClass="btn btn-secondary">
                  <input type="hidden" name="status" value="picked_up" />
                </ActionForm>
              )}
              <ActionForm action={setProgress.bind(null, id)} submitLabel="In Process" submitClass="btn btn-blue">
                <input type="hidden" name="status" value="in_process" />
              </ActionForm>
            </div>
          )}

          {canShipStatus && (
            <div style={{ marginTop: 12 }}>
              <ActionForm action={setShipStatus.bind(null, id)} submitLabel="Save Job Status" submitClass="btn btn-blue">
                <div className="field">
                  <label htmlFor="ship-status">Shipping workflow status</label>
                  <select id="ship-status" name="ship_status" defaultValue={job.shop_ship_status ?? "awaiting_delivery"}>
                    {Object.entries(SHIP_STATUS_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <span className="small">
                    Use this dropdown to update the job as the DPF moves through your shop: Awaiting Delivery → Received → In
                    Process → Ready to Ship → Shipped.
                  </span>
                </div>
              </ActionForm>
            </div>
          )}

          {(awaiting || job.status === "accepted") && (
            <div className="row" style={{ marginTop: 14 }}>
              <DeclineJob action={declineJob.bind(null, id)} />
            </div>
          )}
        </section>

        <section className="section" style={{ marginTop: 0 }}>
          <h3>Settlement preview</h3>
          <div className="bigAmount">{money(settlement)}</div>
          <p className="small">Calculated from CDS-controlled affiliate rates. Customer pricing is not shown.</p>
          {missingRate && <p className="small">Some items have no rate yet. CDS will confirm them.</p>}
        </section>
      </div>

      {/* ------------------------------------------------ services and parts */}
      <section className="section">
        <h3>Services & Parts Used</h3>
        <p className="small">
          Services and parts ordered by CDS are listed here. Add any catalog parts actually used on the job.
        </p>
        {lines.length === 0 && <p className="small">No services or parts on this job yet.</p>}
        {lines.map((l) => (
          <div key={l.id} className={styles.lineRow}>
            <div style={{ minWidth: 0 }}>
              <strong>{l.sku}</strong>
              <div>{l.name}</div>
              <div className="small">{ORIGIN_LABEL[l.origin]}</div>
            </div>
            <div className={styles.lineMoney}>
              <div>
                <div className="small">
                  {qtyText(l.qty)} x {money(l.shop_unit_rate)}
                </div>
                <div className="money">{l.shop_unit_rate === null ? "-" : money(l.shop_unit_rate * l.qty)}</div>
              </div>
              {editable && l.origin === "shop_added" && (
                <ActionButton
                  action={removePart.bind(null, id, l.id)}
                  label="Remove"
                  pendingLabel="Removing..."
                  className="remove"
                />
              )}
            </div>
          </div>
        ))}

        {editable && (
          <div className="uploadBox" style={{ marginTop: 14 }}>
            <h4 style={{ margin: "0 0 8px" }}>Add Parts</h4>
            <ActionForm action={addPart.bind(null, id)} submitLabel="+ Add Part" pendingLabel="Adding..." resetOnSuccess>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="field" style={{ flex: "1 1 220px" }}>
                  <label htmlFor="part-item">
                    Part <span className="req">*</span>
                  </label>
                  <select id="part-item" name="catalog_item" required defaultValue="">
                    <option value="">Select a part...</option>
                    {data.partOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ width: 90 }}>
                  <label htmlFor="part-qty">Qty</label>
                  <input
                    className="input"
                    id="part-qty"
                    name="qty"
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="any"
                    defaultValue={1}
                    required
                  />
                </div>
              </div>
              <div className="notice warning" style={{ margin: "4px 0 0" }}>
                Select from the CDS catalog; prices cannot be typed manually by the affiliate.
              </div>
              <p className="small">
                Parts include gaskets, clamps, bungs and other CDS catalog parts. Services cannot be added here: if more
                work is needed, use Request Additional Authorization below.
              </p>
            </ActionForm>
          </div>
        )}
      </section>

      {/* ------------------------------------------------ extra work */}
      <section className="section">
        <h3>Request Additional Authorization</h3>
        <p className="small">
          Use this only when unexpected repairs, parts or services are needed beyond the original authorization. Do not
          perform the added work until CDS approves it.
        </p>
        {editable && <AuthRequestForm action={requestAuthorization.bind(null, id)} options={data.authOptions} />}
        {authRequests.length === 0 && <p className="small">No additional authorization requests.</p>}
        {authRequests.map((r) => (
          <div key={r.id} className={`authCard ${r.status === "withdrawn" ? "rejected" : r.status}`}>
            <div className="row between" style={{ alignItems: "center" }}>
              <strong>
                AR-{job.wo_number}-{r.seq}
              </strong>
              <span className={`badge ${r.status}`}>{AUTH_STATUS_LABEL[r.status] ?? r.status}</span>
            </div>
            <div style={{ marginTop: 6 }}>
              {r.kind === "service" ? "Service" : "Part"}: <strong>{r.sku}</strong> - {r.name} (Qty {qtyText(r.qty)})
            </div>
            <div className="small" style={{ whiteSpace: "pre-wrap" }}>
              {r.note}
            </div>
            <div className="small">Requested {date(r.requested_at)}</div>
          </div>
        ))}
      </section>

      {/* ------------------------------------------------ attachments */}
      <section className="section" id="attachments">
        <h3>Photos & Attachments</h3>
        <p className="small">
          Attach condition photos, damaged components, part-number tags, shipping damage, or completed-unit photos. These
          stay with the work-order history.
        </p>
        <div className={canUpload ? "grid2" : undefined}>
          {canUpload && <AttachmentForm workOrderId={id} components={componentOptions} />}
          <div>
            {attachments.length === 0 && <p className="small">No attachments yet.</p>}
            <div className="attachmentGrid">
              {attachments.map((a) => {
                const isImage = (a.mime_type ?? "").startsWith("image/");
                return (
                  <div key={a.id} className={styles.attachment}>
                    {a.url && isImage ? (
                      <a href={a.url} target="_blank" rel="noopener noreferrer">
                        {/* Signed storage URLs expire, so next/image caching does not fit here. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="thumb" src={a.url} alt={a.file_name} loading="lazy" />
                      </a>
                    ) : (
                      <a
                        href={a.url ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`thumb ${styles.fileIcon}`}
                      >
                        {isImage ? "Photo" : "PDF"}
                      </a>
                    )}
                    <div className="small" style={{ marginTop: 6 }}>
                      {ATTACHMENT_CATEGORY_LABEL[a.category] ?? a.category}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      {a.url ? (
                        <a className="link" href={a.url} target="_blank" rel="noopener noreferrer">
                          {a.file_name}
                        </a>
                      ) : (
                        a.file_name
                      )}
                    </div>
                    {a.component_id && componentName.get(a.component_id) && (
                      <div className="small">For {componentName.get(a.component_id)}</div>
                    )}
                    {a.note && <div className="small">{a.note}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ components */}
      <section className="section">
        <h3>Components Received</h3>
        <p className="small">
          Add every DPF, DOC, SCR or EGR actually received, one item per component. DPF and DOC need pressure and weight
          before and after; EGR coolers are Pass / Fail only. Every required field must be filled in before completion.
        </p>
        {editable && (
          <ActionForm
            action={addComponent.bind(null, id)}
            submitLabel="+ Add Item"
            pendingLabel="Adding..."
            footer={<span className="small">Current items: {components.length}</span>}
          >
            <div className="field" style={{ maxWidth: 220 }}>
              <label htmlFor="component-type">Component type</label>
              <select id="component-type" name="component_type" defaultValue="DPF">
                <option value="DPF">DPF</option>
                <option value="DOC">DOC</option>
                <option value="SCR">SCR</option>
                <option value="EGR">EGR</option>
              </select>
            </div>
          </ActionForm>
        )}
        {components.length === 0 && <p className="small">No components added yet.</p>}
        {components.map((c) =>
          editable ? (
            <ComponentCard
              key={c.id}
              component={c}
              photoCount={photoCount(c.id)}
              saveAction={saveComponent.bind(null, id, c.id)}
              deleteAction={deleteComponent.bind(null, id, c.id)}
            />
          ) : (
            <ComponentSummary key={c.id} component={c} />
          ),
        )}
      </section>

      {/* ------------------------------------------------ complete */}
      <section className="section">
        <h3>Complete work</h3>
        {editable ? (
          <ActionForm
            action={completeJob.bind(null, id)}
            submitLabel="Complete Work"
            pendingLabel="Completing..."
            submitClass="btn btn-primary"
          >
            <p className="small">
              Work cannot be completed until all required component data and the affiliate invoice/reference number are
              entered. Save each component first.
            </p>
            <div className="field" style={{ maxWidth: 420 }}>
              <label htmlFor="invoice-ref">
                Affiliate Invoice / Reference # <span className="req">*</span>
              </label>
              <input
                className="input"
                id="invoice-ref"
                name="invoice_ref"
                required
                maxLength={100}
                placeholder="Enter invoice or billing reference #"
                defaultValue={job.affiliate_invoice_ref ?? ""}
              />
            </div>
          </ActionForm>
        ) : awaiting ? (
          <p className="small">Accept the job to start work.</p>
        ) : (
          <div className="summarybox">
            <div className="summaryrow">
              <span>Affiliate Invoice / Reference #</span>
              <strong>{job.affiliate_invoice_ref || "-"}</strong>
            </div>
            <div className="summaryrow">
              <span>Completed</span>
              <strong>{date(job.completed_at)}</strong>
            </div>
            <p className="small" style={{ marginBottom: 0 }}>This job is read-only.</p>
          </div>
        )}
        <div className="bottomTotal">
          <div>
            <div className="small" style={{ fontWeight: 800, letterSpacing: "0.05em" }}>
              CURRENT SETTLEMENT TOTAL
            </div>
            <div className="small">From the CDS affiliate rates for the services and parts above.</div>
          </div>
          <div className="amount money">{money(settlement)}</div>
        </div>
      </section>
    </div>
  );
}

function ComponentSummary({ component: c }: { component: ComponentRow }) {
  const isEgr = c.component_type === "EGR";
  const rows: [string, string][] = [
    ["Manufacturer", c.manufacturer ?? "-"],
    ["Part Number", c.part_number ?? "-"],
    ["Serial Number", c.serial_number ?? "-"],
  ];
  if (!isEgr) {
    const removed =
      c.weight_before_g !== null && c.weight_after_g !== null
        ? `${Math.round((c.weight_before_g - c.weight_after_g) * 10) / 10} g`
        : "-";
    rows.push(
      ["Differential Pressure: Before", c.dp_before?.toString() ?? "-"],
      ["Differential Pressure: After", c.dp_after?.toString() ?? "-"],
      ["Weight Before (g)", c.weight_before_g?.toString() ?? "-"],
      ["Weight After (g)", c.weight_after_g?.toString() ?? "-"],
      ["Weight Removed", removed],
    );
  }
  rows.push(["Result", c.result ? (isEgr && c.result === "failed" ? "Fail" : COMPONENT_RESULT_LABEL[c.result]) : "-"]);
  if (c.result_note) rows.push(["Reason", c.result_note]);
  return (
    <div className="component">
      <strong>{componentLabel(c)}</strong>
      <div className="grid3" style={{ marginTop: 8 }}>
        {rows.map(([k, v]) => (
          <div key={k}>
            <div className="small">{k}</div>
            <div>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
