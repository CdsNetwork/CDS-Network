/**
 * BUG (Sarah, CDS, 2026-11-23): "the CDS INC portal shows that we are read-only and cannot add a
 * bill number when completing the WO."
 *
 * Root cause: the shop job page hid the Affiliate Invoice / Reference # field on every order of
 * CDS's in-house shop (data.inHouse), a rule from 2026-11-10 when in-house orders had no bill.
 * The in-house login could only press Complete Work, the database filled in IN-HOUSE-<wo>, and
 * the completed job then showed "This job is read-only" with no way to enter the GESi bill
 * number, although public.shop_complete_work_order has always used a number the in-house login
 * types (20261120000000_in_house_shop_bills.sql relies on it for the vendor bill).
 *
 * Fixed: the in-house job page has the field too, optional, with IN-HOUSE-<wo> as the default
 * when left empty. An outside shop's field stays required.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { JobDetailData } from "@/app/shop/data";
import type { JobRow } from "@/components/shop/types";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("@/app/shop/actions", () => {
  const noop = async () => ({});
  return Object.fromEntries(
    [
      "acceptJob",
      "changePickup",
      "addComponent",
      "addNote",
      "addPart",
      "completeJob",
      "declineJob",
      "deleteComponent",
      "prepareUpload",
      "registerUpload",
      "removeAttachment",
      "removePart",
      "requestAuthorization",
      "requestInvoiceCorrection",
      "saveComponent",
      "setProgress",
      "setShipStatus",
    ].map((name) => [name, noop]),
  );
});

const { JobDetail } = await import("@/components/shop/JobDetail");

function data(over: Partial<JobDetailData>, job: Partial<JobRow> = {}): JobDetailData {
  return {
    job: {
      id: "11111111-1111-4111-8111-111111111111",
      wo_number: 104777,
      status: "in_process",
      market: "US",
      fulfillment: "shipping",
      location_label: "Example Yard",
      site_address: null,
      unit_number: "U-1",
      po_number: "PO-1",
      customer_part_number: null,
      customer_manufacturer: null,
      requested_work: "GESi DPF",
      pickup_window: null,
      pickup_date: null,
      shop_ship_status: "awaiting_delivery",
      affiliate_invoice_ref: null,
      dispatched_at: "2026-11-21T15:00:00Z",
      accepted_at: "2026-11-21T16:00:00Z",
      picked_up_at: null,
      completed_at: null,
      delivered_at: null,
      customer_name: "Example Fleet",
      ...job,
    },
    lines: [],
    components: [],
    authRequests: [],
    attachments: [],
    shipments: [],
    notes: [],
    partOptions: [],
    authOptions: [],
    inHouse: false,
    partsSale: true,
    deductions: [],
    receivedAt: null,
    timeline: [],
    ...over,
  };
}

const page = (d: JobDetailData) => renderToStaticMarkup(createElement(JobDetail, { data: d, backHref: "/shop" }));
const invoiceInput = (html: string) => html.match(/<input[^>]*name="invoice_ref"[^>]*>/)?.[0] ?? null;

describe("in-house job page, completing", () => {
  it("has the bill number field, optional, defaulting to IN-HOUSE-<wo>", () => {
    const html = page(data({ inHouse: true }));
    const input = invoiceInput(html);
    expect(input, "the in-house login must be able to type the GESi bill number").not.toBeNull();
    expect(input).not.toMatch(/\brequired\b/);
    expect(input).toMatch(/placeholder="IN-HOUSE-104777"/);
    expect(html).toMatch(/Leave it empty to use IN-HOUSE-104777/);
  });

  it("keeps a number already on the order in the field", () => {
    const input = invoiceInput(page(data({ inHouse: true }, { affiliate_invoice_ref: "GESI-5521" })));
    expect(input).toMatch(/value="GESI-5521"/);
  });

  it("for a service order at the in-house shop too", () => {
    expect(invoiceInput(page(data({ inHouse: true, partsSale: false })))).not.toBeNull();
  });
});

describe("outside shop (unchanged)", () => {
  it("the field is required", () => {
    expect(invoiceInput(page(data({ inHouse: false })))).toMatch(/\brequired\b/);
  });
});
