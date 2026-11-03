/**
 * Status emails to CDS's dispatch inbox (CDS, 2026-11-04): the portal emails dispatch@ when a
 * work order is sent to a shop, declined by a shop, or finished by a shop. CDS only for now,
 * never to shops. Sent through Resend from portal@in.cds.direct, every subject starts with
 * "[Portal] ". Sending is off unless PORTAL_EMAILS_ENABLED is "true", a failure never reaches
 * the status change, and one status change is emailed once (integration_sync row per change).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPortalEmail,
  notifyWorkOrderEvent,
  PORTAL_FROM,
  portalEmailConfig,
  type PortalEmailDetails,
  type PortalEmailStore,
} from "@/lib/portal-email";

const WO = "11111111-1111-4111-8111-111111111111";

const details = (over: Partial<PortalEmailDetails> = {}): PortalEmailDetails => ({
  workOrderId: WO,
  woNumber: 101592,
  customer: "First Student, Inc",
  location: "FS 12723 Anaheim",
  unitNumber: "284113",
  poNumber: "7741200",
  shop: "Enviromotive",
  at: "2026-11-04T18:15:00Z",
  declineReason: null,
  shopReference: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("buildPortalEmail", () => {
  it("names the work order, what happened and the shop in a [Portal] subject", () => {
    expect(buildPortalEmail("sent", details()).subject).toBe("[Portal] WO 101592 sent to Enviromotive");
    expect(buildPortalEmail("declined", details()).subject).toBe("[Portal] WO 101592 declined by Enviromotive");
    expect(buildPortalEmail("finished", details()).subject).toBe("[Portal] WO 101592 finished by Enviromotive");
  });

  it("writes the customer, location, shop, Pacific time and a link to the work order page", () => {
    const { text, html } = buildPortalEmail("finished", details({ shopReference: "INV-5531" }));
    expect(text).toContain("WO 101592 was finished by Enviromotive.");
    expect(text).toContain("Customer: First Student, Inc");
    expect(text).toContain("Location: FS 12723 Anaheim");
    expect(text).toContain("Unit: 284113");
    expect(text).toContain("PO: 7741200");
    expect(text).toContain("Shop: Enviromotive");
    expect(text).toContain("When: 2026-11-04 10:15 PT");
    expect(text).toContain("Shop invoice / reference: INV-5531");
    expect(text).toContain(`https://cds-network-portal.vercel.app/cds/work-orders/${WO}`);
    expect(html).toContain(`href="https://cds-network-portal.vercel.app/cds/work-orders/${WO}"`);
    expect(html).toContain("First Student, Inc");
  });

  it("gives the shop's decline reason on a declined order", () => {
    const { text, html } = buildPortalEmail("declined", details({ declineReason: "No oven time this week <sorry>" }));
    expect(text).toContain("Decline reason: No oven time this week <sorry>");
    // HTML is escaped.
    expect(html).toContain("No oven time this week &lt;sorry&gt;");
    expect(html).not.toContain("<sorry>");
  });

  it("leaves out empty fields and never shows a price", () => {
    const { subject, text } = buildPortalEmail("sent", details({ poNumber: null, unitNumber: null, shop: null }));
    expect(subject).toBe("[Portal] WO 101592 sent to a shop");
    expect(text).not.toContain("PO:");
    expect(text).not.toContain("Unit:");
    expect(text).not.toMatch(/\$|price/i);
  });

  it("uses no em or en dashes", () => {
    for (const event of ["sent", "declined", "finished"] as const) {
      const e = buildPortalEmail(event, details({ declineReason: "x", shopReference: "y" }));
      expect(`${e.subject}${e.text}${e.html}`).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("portalEmailConfig", () => {
  it("is off unless PORTAL_EMAILS_ENABLED is exactly true", () => {
    expect(portalEmailConfig({}).enabled).toBe(false);
    expect(portalEmailConfig({ PORTAL_EMAILS_ENABLED: "1" }).enabled).toBe(false);
    expect(portalEmailConfig({ PORTAL_EMAILS_ENABLED: "TRUE " }).enabled).toBe(false);
    expect(portalEmailConfig({ PORTAL_EMAILS_ENABLED: "true" }).enabled).toBe(true);
  });

  it("sends to dispatch@cds.direct unless PORTAL_EMAILS_TO overrides it", () => {
    expect(portalEmailConfig({}).to).toEqual(["dispatch@cds.direct"]);
    expect(portalEmailConfig({ PORTAL_EMAILS_TO: " samed@example.com , other@example.com " }).to).toEqual([
      "samed@example.com",
      "other@example.com",
    ]);
  });

  it("uses RESEND_SEND_API_KEY, falling back to RESEND_RECEIVING_API_KEY", () => {
    expect(portalEmailConfig({}).apiKey).toBeNull();
    expect(portalEmailConfig({ RESEND_RECEIVING_API_KEY: "re_recv" }).apiKey).toBe("re_recv");
    expect(portalEmailConfig({ RESEND_RECEIVING_API_KEY: "re_recv", RESEND_SEND_API_KEY: "re_send" }).apiKey).toBe("re_send");
  });
});

/** A store that behaves like integration_sync: one claim per work order and key. */
function memoryStore(found: (PortalEmailDetails & { key: string }) | null = { ...details(), key: "sent:shop:41" }) {
  const rows: { id: number; event: string; workOrderId: string; key: string; status: string; note: string | null }[] = [];
  const store: PortalEmailStore = {
    details: vi.fn(async () => found),
    async claim(event, workOrderId, key) {
      if (rows.some((r) => r.workOrderId === workOrderId && r.key === key)) return null;
      const row = { id: rows.length + 1, event, workOrderId, key, status: "sending", note: null };
      rows.push(row);
      return { rowId: row.id };
    },
    async finish(rowId, status, note) {
      const row = rows.find((r) => r.id === rowId)!;
      row.status = status;
      row.note = note;
    },
  };
  return { store, rows };
}

function fakeResend(response: () => Response | Promise<Response> = () => Response.json({ id: "re_email_123" })) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ON = { PORTAL_EMAILS_ENABLED: "true", RESEND_SEND_API_KEY: "re_send_key" };

describe("notifyWorkOrderEvent", () => {
  it("records the change as skipped and sends nothing while emails are off", async () => {
    const { store, rows } = memoryStore();
    const { fetchImpl } = fakeResend();
    const out = await notifyWorkOrderEvent("sent", WO, { store, env: {}, fetchImpl });
    expect(out.status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", key: "sent:shop:41" });
    expect(rows[0].note).toMatch(/PORTAL_EMAILS_ENABLED/);
  });

  it("sends from the portal address to dispatch@ through Resend and records it", async () => {
    const { store, rows } = memoryStore();
    const { fetchImpl, calls } = fakeResend();
    const out = await notifyWorkOrderEvent("sent", WO, { store, env: ON, fetchImpl });
    expect(out.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].headers.get("authorization")).toBe("Bearer re_send_key");
    expect(calls[0].headers.get("idempotency-key")).toBeTruthy();
    expect(calls[0].body).toMatchObject({
      from: PORTAL_FROM,
      to: ["dispatch@cds.direct"],
      subject: "[Portal] WO 101592 sent to Enviromotive",
    });
    expect(PORTAL_FROM).toBe("CDS Portal <portal@in.cds.direct>");
    expect(String(calls[0].body.text)).toContain("WO 101592");
    expect(rows[0]).toMatchObject({ status: "ok" });
    expect(rows[0].note).toContain("re_email_123");
  });

  it("sends to the PORTAL_EMAILS_TO override", async () => {
    const { store } = memoryStore();
    const { fetchImpl, calls } = fakeResend();
    await notifyWorkOrderEvent("finished", WO, { store, env: { ...ON, PORTAL_EMAILS_TO: "samed@example.com" }, fetchImpl });
    expect(calls[0].body.to).toEqual(["samed@example.com"]);
  });

  it("emails one status change once, even when asked twice (retry or double click)", async () => {
    const { store, rows } = memoryStore();
    const { fetchImpl } = fakeResend();
    const [a, b] = await Promise.all([
      notifyWorkOrderEvent("sent", WO, { store, env: ON, fetchImpl }),
      notifyWorkOrderEvent("sent", WO, { store, env: ON, fetchImpl }),
    ]);
    const again = await notifyWorkOrderEvent("sent", WO, { store, env: ON, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([a.status, b.status, again.status].sort()).toEqual(["duplicate", "duplicate", "ok"]);
    expect(rows).toHaveLength(1);
  });

  it("records a Resend refusal and does not throw", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, rows } = memoryStore();
    const { fetchImpl } = fakeResend(() => Response.json({ name: "validation_error", message: "domain not verified" }, { status: 403 }));
    const out = await notifyWorkOrderEvent("declined", WO, { store, env: ON, fetchImpl });
    expect(out.status).toBe("error");
    expect(rows[0].status).toBe("error");
    expect(rows[0].note).toMatch(/403.*domain not verified/);
    expect(log).toHaveBeenCalled();
  });

  it("records a network failure and does not throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, rows } = memoryStore();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const out = await notifyWorkOrderEvent("finished", WO, { store, env: ON, fetchImpl });
    expect(out.status).toBe("error");
    expect(rows[0]).toMatchObject({ status: "error" });
    expect(rows[0].note).toMatch(/fetch failed/);
  });

  it("records an error when no Resend key is set, without calling Resend", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, rows } = memoryStore();
    const { fetchImpl } = fakeResend();
    const out = await notifyWorkOrderEvent("sent", WO, { store, env: { PORTAL_EMAILS_ENABLED: "true" }, fetchImpl });
    expect(out.status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows[0].note).toMatch(/RESEND_SEND_API_KEY/);
  });

  it("never throws, even when the store itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store: PortalEmailStore = {
      details: async () => {
        throw new Error("database down");
      },
      claim: async () => null,
      finish: async () => {},
    };
    const out = await notifyWorkOrderEvent("sent", WO, { store, env: ON, fetchImpl: fakeResend().fetchImpl });
    expect(out.status).toBe("error");
  });

  it("does not send when the work order or its status change is not found", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = memoryStore(null);
    const { fetchImpl } = fakeResend();
    const out = await notifyWorkOrderEvent("sent", WO, { store, env: ON, fetchImpl });
    expect(out.status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
