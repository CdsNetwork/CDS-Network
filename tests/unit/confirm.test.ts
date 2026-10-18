import { expect, it, vi } from "vitest";
import {
  confirmed,
  DISCONNECT_QUICKBOOKS_CONFIRM,
  removeCustomerLinkConfirm,
  removeItemLinkConfirm,
  removeMeasurementItemConfirm,
  removePartNumberConfirm,
} from "@/components/cds-admin/confirm";
import { voidLabelConfirm } from "@/components/shipping/confirm";

it("BUG-M2-1: a form with a confirm message submits only when the user agrees", () => {
  const yes = vi.fn(() => true);
  const no = vi.fn(() => false);
  expect(confirmed("Remove it?", yes)).toBe(true);
  expect(yes).toHaveBeenCalledWith("Remove it?");
  expect(confirmed("Remove it?", no)).toBe(false);
  expect(no).toHaveBeenCalledWith("Remove it?");
});

it("BUG-M2-1: a form without a confirm message submits without asking", () => {
  const ask = vi.fn(() => false);
  expect(confirmed(undefined, ask)).toBe(true);
  expect(confirmed("", ask)).toBe(true);
  expect(ask).not.toHaveBeenCalled();
});

it("BUG-M2-1: Disconnect QuickBooks says it revokes the connection and who can reconnect", () => {
  expect(DISCONNECT_QUICKBOOKS_CONFIRM).toMatch(/revoke/i);
  expect(DISCONNECT_QUICKBOOKS_CONFIRM).toMatch(/Primary Admin or Company Admin/);
  expect(DISCONNECT_QUICKBOOKS_CONFIRM).not.toMatch(/[\u2013\u2014]/);
});

it("BUG-M2-1: every Remove says what is removed", () => {
  expect(removeCustomerLinkConfirm("RYDER Ryder", "Ryder System")).toBe(
    'Remove the link between RYDER Ryder and QuickBooks customer "Ryder System"? Invoices for this customer cannot be created until it is linked again.',
  );
  expect(removeItemLinkConfirm("SCR DOC", "All customers", "Measurements")).toContain("SCR DOC");
  expect(removeItemLinkConfirm("SCR DOC", "All customers", "Measurements")).toContain("All customers");
  expect(removeItemLinkConfirm("SCR DOC", "All customers", "Measurements")).toContain('"Measurements"');
  expect(removeMeasurementItemConfirm("All customers", "DPF")).toContain("DPF");
  expect(removeMeasurementItemConfirm("All customers", "DPF")).toContain("All customers");
  expect(removePartNumberConfirm("FS", "SVC-EGR", "A-123")).toContain("A-123");
  for (const t of [
    removeCustomerLinkConfirm("a", "b"),
    removeItemLinkConfirm("a", "b", "c"),
    removeMeasurementItemConfirm("a", "b"),
    removePartNumberConfirm("a", "b", "c"),
  ]) {
    expect(t).toMatch(/^Remove /);
    expect(t).not.toMatch(/[\u2013\u2014]/);
  }
});

it("BUG-M2-1: voiding a real label states the consequence, a test label stays short", () => {
  const real = voidLabelConfirm({ is_test: false, carrier: "UPS", tracking_number: "1Z999" });
  expect(real).toContain("UPS");
  expect(real).toContain("1Z999");
  expect(real).toMatch(/can no longer be used/i);
  expect(real).toMatch(/refund/i);
  expect(real).toMatch(/cannot be undone/i);
  expect(voidLabelConfirm({ is_test: true, carrier: "USPS", tracking_number: null })).toBe("Void this test label?");
});
