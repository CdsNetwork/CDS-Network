/**
 * BUG (2026-11-17): Admin > QuickBooks mappings took about 17 seconds on every click because
 * every render read all QuickBooks customers, items, vendors, accounts and terms again (paged,
 * one request after another). The lists are now kept per QuickBooks company for a few minutes
 * (src/lib/qbo/lists.ts): a second load within that time does not call QuickBooks again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const qboApi = vi.fn();
vi.mock("@/lib/qbo/tokens", () => ({ qboApi }));
const qboRequest = vi.fn();
vi.mock("@/lib/qbo/client", () => ({ qboRequest }));

const { qboBillLists, qboMappingLists, QBO_LISTS_TTL_MS, clearQboListsCache } = await import("@/lib/qbo/lists");

const api = (realmId: string) => ({ environment: "production", realmId, accessToken: `token-${realmId}`, astEnabled: null });

/** Answers each "select * from <Entity>" query with one row named after the realm. */
function answerQueries() {
  qboRequest.mockImplementation(async (a: { realmId: string }, _method: string, _path: string, opts: { query: { query: string } }) => {
    const entity = /from (\w+)/.exec(opts.query.query)![1];
    const row =
      entity === "Account"
        ? { Id: "1", Name: `Freight ${a.realmId}`, AccountType: "Expense" }
        : { Id: "1", Name: `${entity} ${a.realmId}`, DisplayName: `${entity} ${a.realmId}` };
    return { QueryResponse: { [entity]: [row] } };
  });
}

describe("QuickBooks lists for the admin mappings and shop bills tabs", () => {
  beforeEach(() => {
    clearQboListsCache();
    qboApi.mockReset();
    qboRequest.mockReset();
    qboApi.mockResolvedValue(api("A"));
    answerQueries();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a second load within the cache window does not call QuickBooks again", async () => {
    const first = await qboMappingLists(true);
    expect(first.error).toBeNull();
    expect(first.customers?.[0].DisplayName).toBe("Customer A");
    expect(first.items?.[0].Name).toBe("Item A");
    const calls = qboRequest.mock.calls.length;
    expect(calls).toBe(2);

    const second = await qboMappingLists(true);
    expect(second.customers).toEqual(first.customers);
    expect(qboRequest).toHaveBeenCalledTimes(calls);

    const bills = await qboBillLists(true);
    expect(bills.lists?.vendors[0].DisplayName).toBe("Vendor A");
    expect(bills.lists?.accounts[0].Name).toBe("Freight A");
    const billCalls = qboRequest.mock.calls.length;
    await qboBillLists(true);
    expect(qboRequest).toHaveBeenCalledTimes(billCalls);
  });

  it("concurrent loads share one set of QuickBooks requests", async () => {
    await Promise.all([qboMappingLists(true), qboMappingLists(true), qboMappingLists(true)]);
    expect(qboRequest).toHaveBeenCalledTimes(2);
  });

  it("reads QuickBooks again after the cache window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await qboMappingLists(true);
    vi.setSystemTime(Date.now() + QBO_LISTS_TTL_MS + 1);
    await qboMappingLists(true);
    expect(qboRequest).toHaveBeenCalledTimes(4);
  });

  it("keeps each QuickBooks company's lists apart", async () => {
    await qboMappingLists(true);
    qboApi.mockResolvedValue(api("B"));
    const b = await qboMappingLists(true);
    expect(b.customers?.[0].DisplayName).toBe("Customer B");
  });

  it("does not keep a failed load", async () => {
    qboRequest.mockRejectedValueOnce(new Error("QuickBooks is down"));
    const failed = await qboMappingLists(true);
    expect(failed.customers).toBeNull();
    expect(failed.error).toMatch(/QuickBooks is down/);
    answerQueries();
    const ok = await qboMappingLists(true);
    expect(ok.error).toBeNull();
    expect(ok.customers?.[0].DisplayName).toBe("Customer A");
  });

  it("does not call QuickBooks when it is not connected", async () => {
    expect(await qboMappingLists(false)).toEqual({ customers: null, items: null, error: null });
    expect(await qboBillLists(false)).toEqual({ lists: null, error: null });
    expect(qboApi).not.toHaveBeenCalled();
  });
});
