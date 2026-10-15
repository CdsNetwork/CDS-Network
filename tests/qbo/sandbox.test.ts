/**
 * Against a QuickBooks sandbox company. Skipped unless these are set in the environment:
 *   QBO_SANDBOX_REALM, QBO_SANDBOX_ACCESS_TOKEN (a current access token for that realm)
 * and, for the invoice test, QBO_SANDBOX_CUSTOMER_ID and QBO_SANDBOX_ITEM_ID.
 * Run with: npx vitest run tests/qbo
 * Note: sandbox companies do not run Automated Sales Tax, so tax amounts are not checked.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { qboRequest, QboError, type QboApi } from "@/lib/qbo/client";
import { buildInvoicePayload } from "@/lib/qbo/invoice";

const realm = process.env.QBO_SANDBOX_REALM;
const token = process.env.QBO_SANDBOX_ACCESS_TOKEN;
const customerId = process.env.QBO_SANDBOX_CUSTOMER_ID;
const itemId = process.env.QBO_SANDBOX_ITEM_ID;

const api: QboApi = { environment: "sandbox", realmId: realm ?? "", accessToken: token ?? "" };

describe.skipIf(!realm || !token)("QuickBooks sandbox", () => {
  it("reads the company and the tax preference", async () => {
    const info = await qboRequest<{ CompanyInfo?: { CompanyName?: string } }>(api, "GET", `companyinfo/${realm}`);
    expect(info.CompanyInfo?.CompanyName).toBeTruthy();
    const prefs = await qboRequest<{ Preferences?: { TaxPrefs?: unknown } }>(api, "GET", "preferences");
    expect(prefs.Preferences).toBeTruthy();
  });

  it("returns an Intuit fault message for a bad request", async () => {
    await expect(qboRequest(api, "GET", "invoice/0")).rejects.toBeInstanceOf(QboError);
  });

  it.skipIf(!customerId || !itemId)("the same requestid never creates a second invoice", async () => {
    const result = buildInvoicePayload(
      {
        id: randomUUID(),
        woNumber: 999999,
        market: "US",
        customerName: "Sandbox",
        poNumber: "TEST",
        unitNumber: "TEST",
        taxParts: true,
        taxLabor: false,
        taxShipping: true,
        customerTaxExempt: false,
      },
      [{ catalogItemId: "x", sku: "TEST", name: "Sandbox test line", qty: 1, customerUnitPrice: 1, taxClass: "parts" }],
      { qboCustomerId: customerId!, qboDisplayName: "Sandbox customer" },
      { x: { qboItemId: itemId!, qboItemName: "Sandbox item" } },
      {},
      { label: "Sandbox", addressLine1: "2600 Marine Way", city: "Mountain View", region: "CA", postalCode: "94043", country: "US" },
    );
    if (!result.ok) throw new Error(result.problems.join("; "));
    const requestId = randomUUID();
    const first = await qboRequest<{ Invoice: { Id: string } }>(api, "POST", "invoice", { body: result.payload, requestId });
    const second = await qboRequest<{ Invoice: { Id: string } }>(api, "POST", "invoice", { body: result.payload, requestId });
    expect(second.Invoice.Id).toBe(first.Invoice.Id);
  });
});
