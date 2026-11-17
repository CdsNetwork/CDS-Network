/**
 * Sarah, CDS, 2026-11-17:
 *  - Shop dates: the shop's job list and job page show when the part was Received and when the
 *    job was Completed. Received = when the carrier delivered the inbound leg (customer to
 *    shop), else when the shop marked a pickup job Picked Up. Completed = completed_at.
 *  - Shop labels: a shop only sees and prints labels for the leg back to the customer
 *    (affiliate_to_customer). Inbound tracking numbers stay visible (the shipments rows). The
 *    database rule is in tests/rls/label-shop-outbound.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { receivedAt, shopCanSeeLabel } from "@/components/shop/shop-dates";

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { message: string } | null; count?: number | null };
let results: Record<string, Result>;

function query(table: string) {
  const res = () => results[table] ?? { data: [], error: null, count: 0 };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "or", "order", "range", "limit", "lte", "ilike"]) q[m] = () => q;
  q.maybeSingle = async () => {
    const r = res();
    return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
  };
  q.then = (ok: (v: Result) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(res()).then(ok, fail);
  return q;
}
const supabase = {
  from: vi.fn((table: string) => query(table)),
  storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => supabase) }));

const { loadJob, loadQueue } = await import("@/app/shop/data");

const WO = "11111111-1111-4111-8111-111111111111";
const inbound = { id: "s-in", direction: "customer_to_affiliate", carrier: "UPS", tracking_number: "1ZIN", status: "delivered", delivered_at: "2026-11-10T18:00:00Z", created_at: "2026-11-09" };
const outbound = { id: "s-out", direction: "affiliate_to_customer", carrier: "UPS", tracking_number: "1ZOUT", status: "label_created", delivered_at: null, created_at: "2026-11-12" };
const job = {
  id: WO, wo_number: 101951, status: "completed", market: "west", fulfillment: "shipping",
  location_label: "Loc 424", site_address: null, unit_number: "284113", po_number: "PO1",
  requested_work: "DPF Cleaning", pickup_window: null, shop_ship_status: null, affiliate_invoice_ref: "INV1",
  picked_up_at: null, completed_at: "2026-11-12T20:00:00Z", customer_id: "c1", affiliate_id: "a1", request_type: "service",
  customers: { name: "Ryder" }, shipments: [{ direction: inbound.direction, delivered_at: inbound.delivered_at }],
};

beforeEach(() => {
  results = {
    work_orders: { data: [job], error: null, count: 1 },
    shipments: { data: [inbound, outbound], error: null },
    // RLS returns only the outbound label; the loader filters as well.
    shipment_labels: {
      data: [
        { id: "l-in", shipment_id: "s-in", service_name: "Ground", tracking_number: "1ZIN", is_test: false },
        { id: "l-out", shipment_id: "s-out", service_name: "Ground", tracking_number: "1ZOUT", is_test: false },
      ],
      error: null,
    },
    affiliates: { data: [{ is_in_house: false }], error: null },
  };
});

describe("receivedAt", () => {
  it("is when the inbound leg was delivered (the earliest one when there are several)", () => {
    expect(
      receivedAt({ picked_up_at: null }, [
        { direction: "customer_to_affiliate", delivered_at: "2026-11-11T10:00:00Z" },
        { direction: "customer_to_affiliate", delivered_at: "2026-11-10T10:00:00Z" },
        { direction: "affiliate_to_customer", delivered_at: "2026-11-01T10:00:00Z" },
      ]),
    ).toBe("2026-11-10T10:00:00Z");
  });
  it("falls back to Picked Up for a pickup job, and is null before the part arrived", () => {
    expect(receivedAt({ picked_up_at: "2026-11-09T15:00:00Z" }, [])).toBe("2026-11-09T15:00:00Z");
    expect(receivedAt({ picked_up_at: null }, [{ direction: "customer_to_affiliate", delivered_at: null }])).toBeNull();
    expect(receivedAt({ picked_up_at: null }, null)).toBeNull();
  });
});

describe("shopCanSeeLabel", () => {
  it("only the leg from the shop back to the customer", () => {
    expect(shopCanSeeLabel("affiliate_to_customer")).toBe(true);
    for (const d of ["customer_to_affiliate", "cds_to_customer", "customer_to_cds", "supplier_to_customer"]) {
      expect(shopCanSeeLabel(d), d).toBe(false);
    }
  });
});

describe("shop queue and job page", () => {
  it("the queue rows carry the Received and Completed times", async () => {
    const q = await loadQueue();
    const j = q.jobs.completed[0];
    expect(j.received_at).toBe("2026-11-10T18:00:00Z");
    expect(j.completed_at).toBe("2026-11-12T20:00:00Z");
  });

  it("the job page has Received, keeps the inbound tracking number, and only the outbound label", async () => {
    const d = await loadJob(WO, () => false);
    expect(d?.receivedAt).toBe("2026-11-10T18:00:00Z");
    const byId = new Map(d!.shipments.map((s) => [s.id, s]));
    expect(byId.get("s-in")?.tracking_number).toBe("1ZIN");
    expect(byId.get("s-in")?.label).toBeNull();
    expect(byId.get("s-out")?.label?.id).toBe("l-out");
  });

  it("the queue and job page show Received and Completed dates", () => {
    const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
    const queue = src("components/shop/JobQueue.tsx");
    expect(queue).toMatch(/Received \{date\(j\.received_at\)\}/);
    expect(queue).toMatch(/Completed \{date\(j\.completed_at\)\}/);
    const detail = src("components/shop/JobDetail.tsx");
    expect(detail).toMatch(/Received/);
    expect(detail).toMatch(/date\(data\.receivedAt\)/);
  });
});
