/**
 * CDS dashboard order and tracking search (20261113010000_work_order_list_order.sql).
 *
 * public.work_order_list is the work order table of the CDS dashboard: work_orders plus
 * list_rank (Sarah's status order, 2026-11-13) and tracking_search (the order's tracking
 * numbers without spaces, in lower case). It is CDS only, and the dashboard's embeds still
 * work through it.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

vi.mock("server-only", () => ({}));
const { filteredWorkOrders, parseFilters } = await import("@/components/cds-wo/woFilters");

let shop: string;
let customer: string;
let cds: Login;
let shopLogin: Login;

const LABEL = `LISTORDER-${runId}`;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(unit: string, status: string, opts: { question?: boolean; condemned?: boolean; tracking?: string } = {}) {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shop,
    status,
    unit_number: unit,
    requested_work: "Test cleaning",
    // Completed and later statuses need the shop's invoice reference.
    affiliate_invoice_ref: ["completed", "delivered", "ready_to_invoice", "invoiced"].includes(status) ? `INV-${unit}` : null,
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  if (opts.question) await must(admin.from("work_order_questions").insert({ work_order_id: wo.id, question_pending: true }));
  if (opts.condemned) {
    await must(
      admin.from("work_order_components").insert({
        work_order_id: wo.id,
        affiliate_id: shop,
        seq: 1,
        component_type: "EGR",
        manufacturer: "Test",
        result: "condemned",
        result_note: "Cracked",
      }),
    );
  }
  if (opts.tracking) {
    await must(admin.from("shipments").insert({ work_order_id: wo.id, direction: "affiliate_to_customer", tracking_number: opts.tracking }));
  }
  return wo.id;
}

const LIST_COLUMNS =
  "id, unit_number, status, list_rank, customers(name), affiliates(display_name, is_in_house), work_order_internal(internal_status), work_order_shop_activity(is_new), work_order_components(result), work_order_questions(question_pending, note)";

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `LO-${runId}`, display_name: `List Order Shop ${runId}` })).id;
  customer = (await insertOne("customers", { code: `LO-${runId}`, name: `List Order Customer ${runId}` })).id;
  cds = await createLogin("cds", null);
  shopLogin = await createLogin("shop", shop);

  // Inserted in reverse of the expected order, so newest first alone would not pass.
  await workOrder("U-cancelled", "cancelled", { question: true });
  await workOrder("U-invoiced", "invoiced", { condemned: true });
  await workOrder("U-condemned", "accepted", { condemned: true });
  await workOrder("U-ready", "ready_to_invoice");
  await workOrder("U-delivered", "delivered");
  await workOrder("U-completed", "completed");
  await workOrder("U-in-process", "in_process", { tracking: `1Z 999 AA1 ${runId}` });
  await workOrder("U-picked-up", "picked_up");
  await workOrder("U-accepted-old", "accepted");
  await workOrder("U-accepted-new", "accepted");
  await workOrder("U-awaiting", "awaiting_acceptance");
  await workOrder("U-declined", "rejected_by_affiliate");
  await workOrder("U-question", "in_process", { question: true, condemned: true });
  await workOrder("U-pending", "pending_review", { question: true });
}, 120_000);

afterAll(async () => {
  const suffix = `%-${runId}`;
  await must(admin.from("work_orders").delete().eq("location_label", LABEL));
  await deleteLogins();
  await must(admin.from("customers").delete().like("code", suffix));
  await must(admin.from("affiliates").delete().like("short_code", suffix));
}, 120_000);

describe("work_order_list", () => {
  it("lists the dashboard in Sarah's status order, newest first within a status, with the embeds", async () => {
    const { query } = await filteredWorkOrders(cds.client as never, parseFilters({ q: LABEL }), LIST_COLUMNS);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data as unknown as { unit_number: string; customers: { name: string } | null; work_order_questions: unknown }[];
    expect(rows.map((r) => r.unit_number)).toEqual([
      "U-pending",
      "U-question",
      "U-declined",
      "U-awaiting",
      "U-accepted-new",
      "U-accepted-old",
      "U-picked-up",
      "U-in-process",
      "U-completed",
      "U-delivered",
      "U-ready",
      "U-condemned",
      "U-invoiced",
      "U-cancelled",
    ]);
    expect(rows[0].customers?.name).toBe(`List Order Customer ${runId}`);
  });

  it("keeps the order across pages (the CSV export pages through it)", async () => {
    const page = async (from: number) => {
      const { query } = await filteredWorkOrders(cds.client as never, parseFilters({ q: LABEL }), "id, unit_number");
      return ((await must(query.range(from, from + 4))) as unknown as { unit_number: string }[]).map((r) => r.unit_number);
    };
    expect([...(await page(0)), ...(await page(5)), ...(await page(10))].slice(0, 6)).toEqual([
      "U-pending",
      "U-question",
      "U-declined",
      "U-awaiting",
      "U-accepted-new",
      "U-accepted-old",
    ]);
  });

  it("keeps the status and Condemned filters", async () => {
    const { query } = await filteredWorkOrders(cds.client as never, parseFilters({ q: LABEL, status: "condemned" }), "id, unit_number");
    const units = ((await must(query)) as unknown as { unit_number: string }[]).map((r) => r.unit_number);
    expect(units).toEqual(["U-question", "U-condemned", "U-invoiced"]);
    const accepted = await filteredWorkOrders(cds.client as never, parseFilters({ q: LABEL, status: "accepted" }), "id, unit_number");
    expect(((await must(accepted.query)) as unknown as { unit_number: string }[]).map((r) => r.unit_number)).toEqual([
      // A condemned part ranks the order after the in-progress statuses (rank 11), even when Accepted.
      "U-accepted-new",
      "U-accepted-old",
      "U-condemned",
    ]);
  });

  it("finds an order by a tracking number, ignoring spaces and case", async () => {
    for (const q of [`1z999aa1${runId}`, `999 AA1 ${runId.toLowerCase()}`, `1Z 999 AA1 ${runId}`]) {
      const { query } = await filteredWorkOrders(cds.client as never, parseFilters({ q }), "id, unit_number");
      const units = ((await must(query)) as unknown as { unit_number: string }[]).map((r) => r.unit_number);
      expect(units, q).toEqual(["U-in-process"]);
    }
  });

  it("is CDS only: a shop reads no rows, even for its own orders", async () => {
    const own = await must(shopLogin.client.from("work_orders").select("id").eq("location_label", LABEL));
    expect((own as unknown[]).length).toBeGreaterThan(0);
    const listed = await must(shopLogin.client.from("work_order_list").select("id").eq("location_label", LABEL));
    expect(listed).toEqual([]);
  });
});
