/**
 * Removing a photo or file from a work order (Sarah, CDS, 2026-11-20: shops added the wrong
 * file and could not remove it).
 *
 * - CDS removes any file on an order, its own or a shop's, at any status
 *   (public.cds_remove_attachment). The event is CDS only.
 * - A shop removes a file its own login uploaded while the job is accepted, picked up or in
 *   process (public.shop_remove_attachment). Never after completion, never a CDS file, never
 *   another shop's file. The event is visible to the shop.
 * - Every removal writes "File removed: <file name> (by <name>)" to the work order history.
 * - Nobody deletes attachment rows directly any more: removals always go through the two
 *   functions, so the history is complete. The functions return the storage path; the app
 *   removes the stored object after the row is gone.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `RMFILE-${runId}`;
const BUCKET = "wo-files";

let shopA: string;
let shopB: string;
let customer: string;
let cds: Login;
let loginA: Login;
let loginB: Login;

async function insertOne<T extends { id: string }>(table: string, row: Record<string, unknown>): Promise<T> {
  return must(admin.from(table).insert(row).select().single()) as Promise<T>;
}

async function workOrder(shop: string | null, status: string, unit: string): Promise<string> {
  const wo = await insertOne("work_orders", {
    customer_id: customer,
    location_label: LABEL,
    fulfillment: "shipping",
    affiliate_id: shop,
    status,
    unit_number: unit,
    requested_work: "Test cleaning",
    affiliate_invoice_ref: "INV-TEST",
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

/** A stored file recorded as registerUpload (shop) or registerCdsUpload (CDS) records it. */
async function file(wo: string, uploadedBy: string | null, name = "photo.png", componentId: string | null = null) {
  const path = `${wo}/${randomUUID()}-${name}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, new Blob([`file ${path}`], { type: "image/png" }));
  if (error) throw new Error(error.message);
  const row = await must(
    admin
      .from("attachments")
      .insert({
        work_order_id: wo,
        component_id: componentId,
        category: "other",
        storage_path: path,
        file_name: name,
        mime_type: "image/png",
        uploaded_by: uploadedBy,
      })
      .select("id")
      .single(),
  );
  return { id: row.id as string, path };
}

const exists = async (id: string) =>
  (await must(admin.from("attachments").select("id").eq("id", id))).length === 1;

const events = async (wo: string) =>
  (await must(
    admin.from("work_order_events").select("event_type, message, shop_visible, actor_id").eq("work_order_id", wo).order("at"),
  )) as { event_type: string; message: string; shop_visible: boolean; actor_id: string | null }[];

beforeAll(async () => {
  shopA = (await insertOne("affiliates", { short_code: `RMA-${runId}`, display_name: `Remove Shop A ${runId}` })).id;
  shopB = (await insertOne("affiliates", { short_code: `RMB-${runId}`, display_name: `Remove Shop B ${runId}` })).id;
  customer = (await insertOne("customers", { code: `RMC-${runId}`, name: `Customer Remove ${runId}` })).id;
  cds = await createLogin("cds", null);
  loginA = await createLogin("shop", shopA);
  loginB = await createLogin("shop", shopB);
}, 120_000);

afterAll(async () => {
  const errors: string[] = [];
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const suffix = `%-${runId}`;
  const rowIds: string[] = [cds?.id, loginA?.id, loginB?.id].filter((v): v is string => !!v);
  let wos: string[] = [];
  await step("find work orders", async () => {
    wos = (await must(admin.from("work_orders").select("id").eq("location_label", LABEL))).map((r: { id: string }) => r.id);
    rowIds.push(...wos);
    if (wos.length) {
      rowIds.push(...(await must(admin.from("attachments").select("id").in("work_order_id", wos))).map((r: { id: string }) => r.id));
    }
  });
  for (const id of wos) {
    await step(`remove files of ${id}`, async () => {
      const { data: objects, error } = await admin.storage.from(BUCKET).list(id);
      if (error) throw new Error(error.message);
      if (objects?.length) {
        const { error: removeError } = await admin.storage.from(BUCKET).remove(objects.map((o) => `${id}/${o.name}`));
        if (removeError) throw new Error(removeError.message);
      }
    });
  }
  await step("delete work orders", () => must(admin.from("work_orders").delete().eq("location_label", LABEL)));
  await step("delete logins", () => deleteLogins());
  await step("delete customers", () => must(admin.from("customers").delete().like("code", suffix)));
  await step("delete shops", () => must(admin.from("affiliates").delete().like("short_code", suffix)));
  if (rowIds.length) await step("delete change log rows", () => must(admin.from("audit_log").delete().in("row_id", rowIds)));
  if (errors.length) throw new Error(`cleanup of run ${runId} incomplete: ${errors.join("; ")}`);
}, 120_000);

describe("a shop removes its own file before the job is completed", () => {
  it("removes a file its login uploaded while accepted, picked up or in process", async () => {
    for (const [i, status] of (["accepted", "picked_up", "in_process"] as const).entries()) {
      const wo = await workOrder(shopA, status, `RM-1${i}`);
      const own = await file(wo, loginA.id, "wrong-unit.png");
      const { data, error } = await loginA.client.rpc("shop_remove_attachment", { p_work_order: wo, p_attachment: own.id });
      expect(error).toBeNull();
      expect(data).toBe(own.path);
      expect(await exists(own.id)).toBe(false);
    }
  });

  it("writes a shop-visible history line naming the file and the shop, and flags the order for CDS", async () => {
    const wo = await workOrder(shopA, "in_process", "RM-2");
    const own = await file(wo, loginA.id, "wrong-unit.png");
    await must(loginA.client.rpc("shop_remove_attachment", { p_work_order: wo, p_attachment: own.id }));
    const removed = (await events(wo)).filter((e) => e.event_type === "file_removed");
    expect(removed).toEqual([
      { event_type: "file_removed", message: `File removed: wrong-unit.png (by Remove Shop A ${runId})`, shop_visible: true, actor_id: loginA.id },
    ]);
    // The shop sees the line in its own history.
    const seen = await must(loginA.client.from("work_order_events").select("message").eq("work_order_id", wo));
    expect(seen.map((e: { message: string }) => e.message)).toContain(`File removed: wrong-unit.png (by Remove Shop A ${runId})`);
    const activity = await must(admin.from("work_order_shop_activity").select("shop_activity, is_new").eq("work_order_id", wo).single());
    expect(activity).toEqual({ shop_activity: "file", is_new: true });
  });

  it("cannot remove its own file once the job is completed or later", async () => {
    for (const [i, status] of (["completed", "delivered", "ready_to_invoice", "invoiced", "awaiting_acceptance"] as const).entries()) {
      const wo = await workOrder(shopA, status, `RM-3${i}`);
      const own = await file(wo, loginA.id);
      const { error } = await loginA.client.rpc("shop_remove_attachment", { p_work_order: wo, p_attachment: own.id });
      expect(error?.code, status).toBe("P0001");
      expect(await exists(own.id)).toBe(true);
    }
  });

  it("cannot remove a CDS file, a file with no uploader, or another shop's file", async () => {
    const wo = await workOrder(shopA, "in_process", "RM-4");
    const fromCds = await file(wo, cds.id);
    const noPerson = await file(wo, null);
    for (const f of [fromCds, noPerson]) {
      const { error } = await loginA.client.rpc("shop_remove_attachment", { p_work_order: wo, p_attachment: f.id });
      expect(error?.code).toBe("P0001");
      expect(error?.message).toBe("Only files your shop added can be removed");
      expect(await exists(f.id)).toBe(true);
    }
    // Shop B cannot reach shop A's order at all.
    const ownA = await file(wo, loginA.id);
    const other = await loginB.client.rpc("shop_remove_attachment", { p_work_order: wo, p_attachment: ownA.id });
    expect(other.error?.code).toBe("P0002");
    expect(await exists(ownA.id)).toBe(true);

    // The order moves to shop B: shop A's old file is not shop B's to remove.
    await must(admin.from("work_orders").update({ affiliate_id: shopB }).eq("id", wo));
    const moved = await loginB.client.rpc("shop_remove_attachment", { p_work_order: wo, p_attachment: ownA.id });
    expect(moved.error?.code).toBe("P0002");
    expect(await exists(ownA.id)).toBe(true);
  });

  it("cannot remove a file of another order through its own order", async () => {
    const mine = await workOrder(shopA, "in_process", "RM-5a");
    const elsewhere = await workOrder(shopA, "in_process", "RM-5b");
    const f = await file(elsewhere, loginA.id);
    const { error } = await loginA.client.rpc("shop_remove_attachment", { p_work_order: mine, p_attachment: f.id });
    expect(error?.code).toBe("P0002");
    expect(await exists(f.id)).toBe(true);
  });

  it("cannot delete rows directly or remove stored objects, and cannot use the CDS function", async () => {
    const wo = await workOrder(shopA, "in_process", "RM-6");
    const own = await file(wo, loginA.id);
    const del = await loginA.client.from("attachments").delete().eq("id", own.id).select("id");
    expect(del.data ?? []).toEqual([]);
    await loginA.client.storage.from(BUCKET).remove([own.path]);
    expect((await admin.storage.from(BUCKET).download(own.path)).error).toBeNull();
    const asCds = await loginA.client.rpc("cds_remove_attachment", { p_work_order: wo, p_attachment: own.id });
    expect(asCds.error?.code).toBe("42501");
    expect(await exists(own.id)).toBe(true);
  });
});

describe("CDS removes any file", () => {
  it("removes a shop's file on a completed order, with a CDS-only history line", async () => {
    const wo = await workOrder(shopA, "completed", "RM-7");
    const shopFile = await file(wo, loginA.id, "wrong-unit.png");
    const { data, error } = await cds.client.rpc("cds_remove_attachment", { p_work_order: wo, p_attachment: shopFile.id });
    expect(error).toBeNull();
    expect(data).toBe(shopFile.path);
    expect(await exists(shopFile.id)).toBe(false);
    const removed = (await events(wo)).filter((e) => e.event_type === "file_removed");
    expect(removed).toEqual([
      { event_type: "file_removed", message: `File removed: wrong-unit.png (by RLS cds ${runId})`, shop_visible: false, actor_id: cds.id },
    ]);
    const seen = await must(loginA.client.from("work_order_events").select("message").eq("work_order_id", wo));
    expect(seen.map((e: { message: string }) => e.message)).not.toContain(`File removed: wrong-unit.png (by RLS cds ${runId})`);
    // The stored object goes with CDS's own login (storage policy for CDS).
    const { error: removeError } = await cds.client.storage.from(BUCKET).remove([shopFile.path]);
    expect(removeError).toBeNull();
    expect((await admin.storage.from(BUCKET).download(shopFile.path)).error).not.toBeNull();
  });

  it("removes its own file and a file with no uploader, at any status", async () => {
    const wo = await workOrder(shopA, "invoiced", "RM-8");
    for (const f of [await file(wo, cds.id), await file(wo, null)]) {
      await must(cds.client.rpc("cds_remove_attachment", { p_work_order: wo, p_attachment: f.id }));
      expect(await exists(f.id)).toBe(false);
    }
  });

  it("answers not found for a file of another order", async () => {
    const wo = await workOrder(shopA, "in_process", "RM-9a");
    const other = await workOrder(shopA, "in_process", "RM-9b");
    const f = await file(other, loginA.id);
    const { error } = await cds.client.rpc("cds_remove_attachment", { p_work_order: wo, p_attachment: f.id });
    expect(error?.code).toBe("P0002");
    expect(await exists(f.id)).toBe(true);
  });

  it("can no longer delete attachment rows directly (every removal is logged)", async () => {
    const wo = await workOrder(shopA, "in_process", "RM-10");
    const f = await file(wo, cds.id);
    const del = await cds.client.from("attachments").delete().eq("id", f.id).select("id");
    expect(del.error?.code).toBe("42501");
    expect(await exists(f.id)).toBe(true);
  });
});
