/**
 * Retrying status emails to CDS that failed (review 2026-11-16 M4;
 * 20261118050000_portal_email_retry.sql, src/lib/portal-email-retry.ts).
 *
 * The first claim of a status change used to win whatever its outcome, so an email that failed
 * (Resend down) or was abandoned mid-send was never sent: later attempts said "already emailed".
 * Now a claim that ended in error, or is still sending after 5 minutes, is taken over (within 24
 * hours of the change, Resend's idempotency window); skipped stays skipped (emails turned off on
 * purpose). The retry sends with the same Resend idempotency key, so Resend never sends twice.
 * The cron sweep retries such emails at most 3 times in all.
 *
 * Run with the service role like the server. Resend is stubbed: nothing is sent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { notifyWorkOrderEvent } from "@/lib/portal-email";
import { retryPortalEmails } from "@/lib/portal-email-retry";
import { supabasePortalEmailStore } from "@/lib/portal-email-store";
import { admin, must, runId } from "./helpers";

const LABEL = `PER-${runId}`;
let shop: string;
let customer: string;
const store = supabasePortalEmailStore(admin);
const ON = { PORTAL_EMAILS_ENABLED: "true", RESEND_SEND_API_KEY: "re_test_not_real" };

function resend(answers: ("ok" | "down")[]) {
  const keys: string[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    const answer = answers.shift() ?? "ok";
    return answer === "ok" ? Response.json({ id: `re_${runId}_${keys.length}` }) : Response.json({ message: "Service unavailable" }, { status: 503 });
  }) as unknown as typeof fetch;
  return { fetchImpl, keys };
}

async function insertOne(table: string, row: Record<string, unknown>): Promise<{ id: string }> {
  return must(admin.from(table).insert(row).select("id").single()) as Promise<{ id: string }>;
}

/** A dispatched order: its "sent" email is the one under test. */
async function dispatched(): Promise<string> {
  const wo = (
    await insertOne("work_orders", {
      customer_id: customer,
      location_label: LABEL,
      affiliate_id: shop,
      status: "awaiting_acceptance",
      unit_number: "U-PER",
      requested_work: "Test cleaning",
    })
  ).id;
  await must(admin.from("work_order_internal").insert({ work_order_id: wo }));
  await must(admin.from("work_order_events").insert({ work_order_id: wo, event_type: "create", from_status: "pending_review", to_status: "pending_review", message: "Created", shop_visible: true }));
  await must(
    admin.from("work_order_events").insert({
      work_order_id: wo,
      event_type: "dispatch",
      from_status: "pending_review",
      to_status: "awaiting_acceptance",
      message: `Approved and dispatched to Shop PER ${runId}`,
      shop_visible: true,
    }),
  );
  return wo;
}

const rows = async (wo: string) =>
  must(admin.from("integration_sync").select("id, status, attempts, at").eq("system", "email").eq("entity_id", wo).order("id")) as Promise<
    { id: number; status: string; attempts: number; at: string }[]
  >;
const owner = async (wo: string) => (await rows(wo))[0];
const age = (wo: string, rowId: number, minutes: number) =>
  must(admin.from("integration_sync").update({ at: new Date(Date.now() - minutes * 60_000).toISOString(), attempted_at: null }).eq("id", rowId).eq("entity_id", wo));

beforeAll(async () => {
  shop = (await insertOne("affiliates", { short_code: `PER-${runId}`, display_name: `Shop PER ${runId}` })).id;
  customer = (await insertOne("customers", { code: `PER-${runId}`, name: `Customer PER ${runId}` })).id;
}, 120_000);

afterAll(async () => {
  const wos = await must(admin.from("work_orders").select("id").eq("location_label", LABEL));
  const ids = wos.map((w: { id: string }) => w.id);
  if (ids.length) await admin.from("integration_sync").delete().in("entity_id", ids);
  await admin.from("work_orders").delete().eq("location_label", LABEL);
  await admin.from("customers").delete().eq("id", customer);
  await admin.from("affiliates").delete().eq("id", shop);
}, 120_000);

describe("a failed status email", () => {
  it("is retried when the same change is reported again (it used to say already emailed)", async () => {
    const wo = await dispatched();
    const r = resend(["down", "ok"]);
    expect((await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl })).status).toBe("error");
    const again = await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl });
    expect(again).toMatchObject({ status: "ok" });
  });

  it("is sent on the next attempt instead of being reported as already emailed, with the same Resend key", async () => {
    const wo = await dispatched();
    const r = resend(["down", "ok"]);
    expect((await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl })).status).toBe("error");
    expect((await owner(wo)).status).toBe("error");

    const again = await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl });
    expect(again.status).toBe("ok");
    expect(r.keys).toHaveLength(2);
    expect(r.keys[1]).toBe(r.keys[0]);
    expect(await owner(wo)).toMatchObject({ status: "ok", attempts: 2 });
    // Sent now: a third attempt stands down.
    expect((await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl })).status).toBe("duplicate");
    expect(r.keys).toHaveLength(2);
  });

  it("is taken over when it was abandoned while sending for more than 5 minutes, not before", async () => {
    const wo = await dispatched();
    const d = (await store.details("sent", wo))!;
    const first = (await store.claim("sent", wo, d.key))!;
    expect(await store.claim("sent", wo, d.key)).toBeNull();
    await age(wo, first.rowId, 6);
    expect(await store.claim("sent", wo, d.key)).toEqual({ rowId: first.rowId });
  });

  it("stays skipped when emails were turned off", async () => {
    const wo = await dispatched();
    expect((await notifyWorkOrderEvent("sent", wo, { store, env: {} })).status).toBe("skipped");
    const r = resend(["ok"]);
    expect((await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl })).status).toBe("duplicate");
    expect(r.keys).toHaveLength(0);
  });

  it("is not taken over after 24 hours (Resend keeps the key only that long)", async () => {
    const wo = await dispatched();
    const r = resend(["down"]);
    await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl });
    await age(wo, (await owner(wo)).id, 25 * 60);
    expect((await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: r.fetchImpl })).status).toBe("duplicate");
  });
});

describe("retryPortalEmails (cron sweep)", () => {
  it("retries failed and abandoned emails of the last 24 hours, at most 3 attempts in all", async () => {
    const failed = await dispatched();
    const abandoned = await dispatched();
    const old = await dispatched();
    await notifyWorkOrderEvent("sent", failed, { store, env: ON, fetchImpl: resend(["down"]).fetchImpl });
    const d = (await store.details("sent", abandoned))!;
    const claimed = (await store.claim("sent", abandoned, d.key))!;
    await age(abandoned, claimed.rowId, 10);
    await notifyWorkOrderEvent("sent", old, { store, env: ON, fetchImpl: resend(["down"]).fetchImpl });
    await age(old, (await owner(old)).id, 25 * 60);

    // Resend is down again for the failed one, up for the abandoned one.
    const down = resend(["down", "ok"]);
    const ours = [failed, abandoned, old];
    const first = await retryPortalEmails(admin, { env: ON, fetchImpl: down.fetchImpl, workOrderIds: ours });
    expect(first).toMatchObject({ tried: 2, sent: 1, failed: 1 });
    expect(await owner(failed)).toMatchObject({ status: "error", attempts: 2 });
    expect(await owner(abandoned)).toMatchObject({ status: "ok", attempts: 2 });
    expect((await owner(old)).status).toBe("error");

    const second = resend(["down"]);
    await retryPortalEmails(admin, { env: ON, fetchImpl: second.fetchImpl, workOrderIds: ours });
    expect(await owner(failed)).toMatchObject({ status: "error", attempts: 3 });

    // Third attempt was the last one.
    const third = resend(["ok"]);
    expect(await retryPortalEmails(admin, { env: ON, fetchImpl: third.fetchImpl, workOrderIds: ours })).toMatchObject({ tried: 0 });
    expect(third.keys).toHaveLength(0);
    expect(new Set([...down.keys, ...second.keys]).size).toBe(2);
  });

  it("does nothing while emails are turned off", async () => {
    const wo = await dispatched();
    await notifyWorkOrderEvent("sent", wo, { store, env: ON, fetchImpl: resend(["down"]).fetchImpl });
    const r = resend(["ok"]);
    expect(await retryPortalEmails(admin, { env: {}, fetchImpl: r.fetchImpl, workOrderIds: [wo] })).toMatchObject({ tried: 0 });
    expect((await owner(wo)).status).toBe("error");
  });
});
