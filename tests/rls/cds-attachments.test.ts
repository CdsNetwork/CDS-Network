/**
 * Photos and files CDS adds to a work order.
 *
 * CDS uploads to the private bucket and records the file itself (no service role needed).
 * A CDS file keeps no shop stamp, so the shop that has the order, now or later, sees it and
 * can download it while shop_visible is on; with shop_visible off no shop sees the row or
 * the file. Another shop never sees it. A shop cannot change shop_visible, delete a CDS
 * file or remove the stored object. Files a shop adds keep the shop stamp, as before.
 *
 * Fixtures are created with the service role under a per-run id and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createLogin, deleteLogins, must, runId, type Login } from "./helpers";

const LABEL = `CDSFILES-${runId}`;
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
  });
  await must(admin.from("work_order_internal").insert({ work_order_id: wo.id }));
  return wo.id;
}

/** CDS uploads with its own login and records the file, as registerCdsUpload does. */
async function cdsUpload(wo: string, shopVisible: boolean) {
  const path = `${wo}/${randomUUID()}-photo.png`;
  const body = `cds file ${path}`;
  const { error } = await cds.client.storage.from(BUCKET).upload(path, new Blob([body], { type: "image/png" }));
  if (error) throw new Error(error.message);
  const row = await must(
    cds.client
      .from("attachments")
      .insert({
        work_order_id: wo,
        category: "other",
        storage_path: path,
        file_name: "photo.png",
        mime_type: "image/png",
        size_bytes: body.length,
        uploaded_by: cds.id,
        shop_visible: shopVisible,
      })
      .select("id, affiliate_id, shop_visible")
      .single(),
  );
  return { id: row.id as string, path, body, row };
}

const shopRows = async (who: Login, wo: string) =>
  (await must(who.client.from("attachments").select("id, affiliate_id").eq("work_order_id", wo))) as {
    id: string;
    affiliate_id: string | null;
  }[];

const download = (who: Login, path: string) => who.client.storage.from(BUCKET).download(path);

beforeAll(async () => {
  shopA = (await insertOne("affiliates", { short_code: `CFA-${runId}`, display_name: `Shop Files A ${runId}` })).id;
  shopB = (await insertOne("affiliates", { short_code: `CFB-${runId}`, display_name: `Shop Files B ${runId}` })).id;
  customer = (await insertOne("customers", { code: `CFC-${runId}`, name: `Customer Files ${runId}` })).id;
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

describe("CDS photos and files on a work order", () => {
  it("CDS uploads and records a file itself; the file keeps no shop stamp", async () => {
    const wo = await workOrder(shopA, "accepted", "CF-1");
    const file = await cdsUpload(wo, true);
    expect(file.row).toMatchObject({ affiliate_id: null, shop_visible: true });
    const { data } = await cds.client.storage.from(BUCKET).download(file.path);
    expect(await data?.text()).toBe(file.body);
  });

  it("a file CDS added before dispatch reaches the shop the order is dispatched to", async () => {
    const wo = await workOrder(null, "pending_review", "CF-2");
    const file = await cdsUpload(wo, true);
    expect(await shopRows(loginA, wo)).toEqual([]);
    expect((await download(loginA, file.path)).error).not.toBeNull();

    await must(admin.from("work_orders").update({ affiliate_id: shopA, status: "awaiting_acceptance" }).eq("id", wo));
    expect(await shopRows(loginA, wo)).toEqual([{ id: file.id, affiliate_id: null }]);
    const { data, error } = await download(loginA, file.path);
    expect(error).toBeNull();
    expect(await data?.text()).toBe(file.body);
    // Another shop sees nothing.
    expect(await shopRows(loginB, wo)).toEqual([]);
    expect((await download(loginB, file.path)).error).not.toBeNull();
  });

  it("a file CDS added while shop A had the order follows the order to shop B; shop A's own file does not", async () => {
    const wo = await workOrder(shopA, "accepted", "CF-3");
    const file = await cdsUpload(wo, true);
    // A file the shop added (recorded by the server with the shop as uploader) is stamped with shop A.
    const shopPath = `${wo}/${randomUUID()}-shop.png`;
    await admin.storage.from(BUCKET).upload(shopPath, new Blob(["shop file"], { type: "image/png" }));
    const shopFile = await must(
      admin
        .from("attachments")
        .insert({ work_order_id: wo, category: "other", storage_path: shopPath, file_name: "shop.png", uploaded_by: loginA.id })
        .select("id, affiliate_id")
        .single(),
    );
    expect(shopFile.affiliate_id).toBe(shopA);
    expect((await shopRows(loginA, wo)).map((r) => r.id).sort()).toEqual([file.id, shopFile.id].sort());

    await must(cds.client.from("work_orders").update({ affiliate_id: shopB }).eq("id", wo));
    expect(await shopRows(loginB, wo)).toEqual([{ id: file.id, affiliate_id: null }]);
    expect((await download(loginB, file.path)).error).toBeNull();
    expect((await download(loginB, shopPath)).error).not.toBeNull();
    expect(await shopRows(loginA, wo)).toEqual([]);
    expect((await download(loginA, file.path)).error).not.toBeNull();
  });

  it("a CDS-only file never reaches the shop, as a row or as a download", async () => {
    const wo = await workOrder(shopA, "accepted", "CF-4");
    const file = await cdsUpload(wo, false);
    expect(file.row.shop_visible).toBe(false);
    expect(await shopRows(loginA, wo)).toEqual([]);
    expect((await download(loginA, file.path)).error).not.toBeNull();
    const signed = await loginA.client.storage.from(BUCKET).createSignedUrl(file.path, 60);
    expect(signed.data?.signedUrl ?? null).toBeNull();

    // CDS turns it on: the shop sees it. CDS turns it off again: gone.
    await must(cds.client.from("attachments").update({ shop_visible: true }).eq("id", file.id));
    expect(await shopRows(loginA, wo)).toEqual([{ id: file.id, affiliate_id: null }]);
    expect((await download(loginA, file.path)).error).toBeNull();
    await must(cds.client.from("attachments").update({ shop_visible: false }).eq("id", file.id));
    expect(await shopRows(loginA, wo)).toEqual([]);
    // The hosted storage CDN can answer a repeat GET of the same object for the same login
    // from its cache for up to an hour, so ask past the cache: storage itself refuses, and
    // no new signed link is issued (the shop page only ever shows signed links).
    const fresh = await loginA.client.storage.from(BUCKET).download(file.path, { cacheNonce: randomUUID() });
    expect(fresh.error).not.toBeNull();
    const relink = await loginA.client.storage.from(BUCKET).createSignedUrl(file.path, 60);
    expect(relink.data?.signedUrl ?? null).toBeNull();
  });

  it("a shop cannot change shop_visible, delete a CDS file, remove its object, or record a file itself", async () => {
    const wo = await workOrder(shopA, "accepted", "CF-5");
    const visible = await cdsUpload(wo, true);
    const hidden = await cdsUpload(wo, false);

    for (const file of [visible, hidden]) {
      const upd = await loginA.client
        .from("attachments")
        .update({ shop_visible: !file.row.shop_visible })
        .eq("id", file.id)
        .select("id");
      expect(upd.data ?? []).toEqual([]);
      const del = await loginA.client.from("attachments").delete().eq("id", file.id).select("id");
      expect(del.data ?? []).toEqual([]);
      await loginA.client.storage.from(BUCKET).remove([file.path]);
      const row = await must(admin.from("attachments").select("shop_visible").eq("id", file.id).single());
      expect(row.shop_visible).toBe(file.row.shop_visible);
      const { data } = await admin.storage.from(BUCKET).download(file.path);
      expect(await data?.text()).toBe(file.body);
    }

    const insert = await loginA.client.from("attachments").insert({
      work_order_id: wo,
      category: "other",
      storage_path: `${wo}/${randomUUID()}-x.png`,
      file_name: "x.png",
    });
    expect(insert.error?.code).toBe("42501");
  });

  it("CDS deletes its file and the stored object", async () => {
    const wo = await workOrder(shopA, "accepted", "CF-6");
    const file = await cdsUpload(wo, true);
    const deleted = await must(cds.client.from("attachments").delete().eq("id", file.id).select("id"));
    expect(deleted).toHaveLength(1);
    const { error } = await cds.client.storage.from(BUCKET).remove([file.path]);
    expect(error).toBeNull();
    expect((await admin.storage.from(BUCKET).download(file.path)).error).not.toBeNull();
    expect(await shopRows(loginA, wo)).toEqual([]);
  });
});
