"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireShop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ATTACHMENT_CATEGORY_LABEL, PICKUP_WINDOWS, SHIP_STATUS_LABEL } from "@/lib/format";
import type { ActionState } from "@/components/shop/types";
import { isUuid } from "./data";

// Every action re-checks the shop login, then calls a database function as that user.
// The functions check that the work order belongs to this shop and that the step is
// allowed; their error messages are written for users and are shown as-is.

type RpcError = { code?: string; message: string } | null;

function rpcError(error: RpcError): ActionState {
  if (!error) return { ok: Date.now() };
  // Raised by our functions (P0001 rule broken, P0002 not found, 42501 not allowed).
  if (error.code === "P0001" || error.code === "P0002" || error.code === "42501") return { error: error.message };
  // Constraint errors (23xxx) and invalid input (22xxx) come from values the form let through.
  if (error.code?.startsWith("23") || error.code?.startsWith("22")) {
    return { error: "Some values are not valid. Check the fields and try again." };
  }
  return { error: "Something went wrong. Try again, or contact CDS if it keeps happening." };
}

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

function done(error: RpcError): ActionState {
  const state = rpcError(error);
  if (!state.error) revalidatePath("/shop");
  return state;
}

/** Parses an optional decimal field. Returns undefined when the text is not a number. */
function decimal(fd: FormData, key: string): number | null | undefined {
  const raw = text(fd, key).replace(",", ".");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function guard(workOrderId: string) {
  await requireShop();
  if (!isUuid(workOrderId)) return { error: "Work order not found" };
  return null;
}

// ---------------------------------------------------------------- acceptance and progress

export async function acceptJob(workOrderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const window = text(fd, "pickup_window");
  if (window && !PICKUP_WINDOWS.some((w) => w.value === window)) return { error: "Choose a pickup window." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_accept_work_order", {
    p_work_order: workOrderId,
    p_pickup_window: window || null,
  });
  return done(error);
}

export async function declineJob(workOrderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const reason = text(fd, "reason");
  if (!reason) return { error: "Tell CDS why you are declining this job" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_decline_work_order", { p_work_order: workOrderId, p_reason: reason });
  if (error) return rpcError(error);
  revalidatePath("/shop");
  // The job goes back to CDS and is no longer visible to this shop.
  redirect("/shop?declined=1");
}

export async function setProgress(workOrderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const status = text(fd, "status");
  if (status !== "picked_up" && status !== "in_process") return { error: "Shops can only set Picked Up or In Process" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_set_progress", { p_work_order: workOrderId, p_status: status });
  return done(error);
}

export async function setShipStatus(workOrderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const status = text(fd, "ship_status");
  if (!(status in SHIP_STATUS_LABEL)) return { error: "Choose a shipping status." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_set_ship_status", { p_work_order: workOrderId, p_status: status });
  return done(error);
}

// ---------------------------------------------------------------- parts and extra work

export async function addPart(workOrderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const item = text(fd, "catalog_item");
  const qty = decimal(fd, "qty");
  if (!isUuid(item)) return { error: "Pick a part from the catalog." };
  if (qty === undefined || qty === null || qty <= 0) return { error: "Quantity must be more than zero" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_add_part", { p_work_order: workOrderId, p_catalog_item: item, p_qty: qty });
  return done(error);
}

export async function removePart(workOrderId: string, lineId: string): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  if (!isUuid(lineId)) return { error: "Only parts your shop added can be removed" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_remove_part", { p_work_order: workOrderId, p_line: lineId });
  return done(error);
}

export async function requestAuthorization(
  workOrderId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const item = text(fd, "catalog_item");
  const qty = decimal(fd, "qty");
  const note = text(fd, "note");
  if (!isUuid(item)) return { error: "Pick an item from the catalog" };
  if (qty === undefined || (qty !== null && qty <= 0)) return { error: "Quantity must be more than zero" };
  if (!note) return { error: "Enter a reason for the additional authorization request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_request_authorization", {
    p_work_order: workOrderId,
    p_catalog_item: item,
    p_qty: qty ?? 1,
    p_note: note,
  });
  return done(error);
}

// ---------------------------------------------------------------- components

const COMPONENT_TYPES = ["DPF", "DOC", "SCR", "EGR"] as const;

export async function addComponent(workOrderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const type = text(fd, "component_type");
  if (!COMPONENT_TYPES.includes(type as (typeof COMPONENT_TYPES)[number])) return { error: "Choose a component type." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_save_component", {
    p_work_order: workOrderId,
    p_component: null,
    p_type: type,
    p_manufacturer: null,
    p_part_number: null,
    p_serial_number: null,
    p_dp_before: null,
    p_dp_after: null,
    p_weight_before_g: null,
    p_weight_after_g: null,
    p_result: null,
    p_result_note: null,
  });
  return done(error);
}

export async function saveComponent(
  workOrderId: string,
  componentId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  if (!isUuid(componentId)) return { error: "Component not found" };
  const type = text(fd, "component_type");
  if (!COMPONENT_TYPES.includes(type as (typeof COMPONENT_TYPES)[number])) return { error: "Choose a component type." };
  const isEgr = type === "EGR";

  const result = text(fd, "result") || null;
  const allowed = isEgr ? ["passed", "failed"] : ["cleaned", "failed", "condemned"];
  if (result && !allowed.includes(result)) {
    return { error: isEgr ? "EGR result is Pass or Fail." : "Choose Cleaned Successfully, Failed or Condemned." };
  }
  const note = text(fd, "result_note");
  if ((result === "failed" || result === "condemned") && !note) {
    return { error: "Enter the failure / condemn reason." };
  }

  const dpBefore = isEgr ? null : decimal(fd, "dp_before");
  const dpAfter = isEgr ? null : decimal(fd, "dp_after");
  const wBefore = isEgr ? null : decimal(fd, "weight_before_g");
  const wAfter = isEgr ? null : decimal(fd, "weight_after_g");
  if ([dpBefore, dpAfter, wBefore, wAfter].some((v) => v === undefined)) {
    return { error: "Pressure and weight must be numbers, for example 2.5." };
  }
  if ((dpBefore ?? 0) < 0 || (dpAfter ?? 0) < 0) return { error: "Pressure cannot be negative." };
  if ((wBefore ?? 1) <= 0 || (wAfter ?? 1) <= 0) {
    return { error: "Weight must be more than zero grams." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_save_component", {
    p_work_order: workOrderId,
    p_component: componentId,
    p_type: type,
    p_manufacturer: text(fd, "manufacturer"),
    p_part_number: text(fd, "part_number"),
    p_serial_number: text(fd, "serial_number"),
    p_dp_before: dpBefore,
    p_dp_after: dpAfter,
    p_weight_before_g: wBefore,
    p_weight_after_g: wAfter,
    p_result: result,
    p_result_note: result === "failed" || result === "condemned" ? note : null,
  });
  return done(error);
}

export async function deleteComponent(workOrderId: string, componentId: string): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  if (!isUuid(componentId)) return { error: "Component not found" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_delete_component", { p_work_order: workOrderId, p_component: componentId });
  return done(error);
}

// ---------------------------------------------------------------- completion

export async function completeJob(workOrderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const bad = await guard(workOrderId);
  if (bad) return bad;
  const ref = text(fd, "invoice_ref");
  if (!ref) return { error: "Enter your invoice or reference number" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("shop_complete_work_order", { p_work_order: workOrderId, p_invoice_ref: ref });
  return done(error);
}

// ---------------------------------------------------------------- attachments
//
// Files go straight from the phone to storage, so large photos never pass through a
// server action (Next.js and Vercel cap request bodies). Two steps, both checked here:
//   1. prepareUpload: checks the shop, the job and the declared file, then returns a
//      one-time signed upload URL token for a path inside this work order's folder.
//   2. registerUpload: after the browser uploaded, checks again, reads the real size and
//      type from storage (deleting the file if it breaks the rules), then records it.

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
const UPLOAD_STATUSES = ["accepted", "picked_up", "in_process", "completed"];
const BUCKET = "wo-files";

function safeName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "");
  return (cleaned || "file").slice(-100);
}

export type UploadMeta = {
  category: string;
  componentId: string | null;
  note: string | null;
};
export type DeclaredFile = { name: string; type: string; size: number };
export type PrepareResult = { error: string } | { path: string; token: string };

function checkFile(name: string, type: string, size: number): string | null {
  if (!ALLOWED_MIME.has(type)) return `${name}: only photos (JPG, PNG, HEIC, WebP, GIF) and PDF files can be added.`;
  if (!(size > 0)) return `${name} is empty.`;
  if (size > MAX_BYTES) return `${name} is larger than 25 MB.`;
  return null;
}

/** Shared checks for both steps. Uses the shop's own client, so RLS decides visibility. */
async function checkUploadTarget(workOrderId: string, meta: UploadMeta): Promise<string | null> {
  if (!isUuid(workOrderId)) return "Work order not found";
  if (!(meta.category in ATTACHMENT_CATEGORY_LABEL)) return "Choose a category.";
  if (meta.componentId !== null && !isUuid(meta.componentId)) return "Component not found";
  if (meta.note !== null && typeof meta.note !== "string") return "The note is not valid.";

  const supabase = await createClient();
  const { data: wo } = await supabase.from("work_orders").select("id, status").eq("id", workOrderId).maybeSingle();
  if (!wo) return "Work order not found";
  if (!UPLOAD_STATUSES.includes(wo.status)) return "Files can be added once the job is accepted.";
  if (meta.componentId) {
    const { data: comp } = await supabase
      .from("work_order_components")
      .select("id")
      .eq("id", meta.componentId)
      .eq("work_order_id", workOrderId)
      .maybeSingle();
    if (!comp) return "Component not found";
  }
  return null;
}

export async function prepareUpload(workOrderId: string, meta: UploadMeta, file: DeclaredFile): Promise<PrepareResult> {
  await requireShop();
  const name = String(file?.name ?? "");
  const bad = checkFile(name || "File", String(file?.type ?? ""), Number(file?.size));
  if (bad) return { error: bad };
  const targetError = await checkUploadTarget(workOrderId, meta);
  if (targetError) return { error: targetError };

  const path = `${workOrderId}/${randomUUID()}-${safeName(name)}`;
  const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { error: `${name} could not be prepared for upload. Try again.` };
  return { path: data.path, token: data.token };
}

const PATH_RE = /^([0-9a-f-]{36})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$/i;

/** Real size and type of a stored object, from storage metadata. */
async function storedObject(path: string): Promise<{ size: number; type: string } | null> {
  const bucket = createAdminClient().storage.from(BUCKET);
  const { data } = await bucket.info(path);
  if (data) return { size: Number(data.size ?? 0), type: String(data.contentType ?? "") };
  // Fallback for storage versions without the info endpoint: list the folder.
  const slash = path.indexOf("/");
  const { data: list } = await bucket.list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 5 });
  const obj = list?.find((o) => o.name === path.slice(slash + 1));
  if (!obj) return null;
  const md = (obj.metadata ?? {}) as { size?: number; mimetype?: string };
  return { size: Number(md.size ?? 0), type: String(md.mimetype ?? "") };
}

export async function registerUpload(
  workOrderId: string,
  meta: UploadMeta,
  path: string,
  fileName: string,
): Promise<ActionState> {
  const profile = await requireShop();
  const label = String(fileName ?? "").slice(0, 200) || "File";
  // The path must sit in this work order's folder and have the shape prepareUpload makes.
  const m = typeof path === "string" ? PATH_RE.exec(path) : null;
  if (!m || m[1].toLowerCase() !== String(workOrderId).toLowerCase()) return { error: `${label} could not be saved.` };

  const admin = createAdminClient();
  // Removes the uploaded object, unless it is already recorded (a replayed request must
  // never delete a file that belongs to an existing attachment).
  const discard = async (message: string): Promise<ActionState> => {
    const { data: existing } = await admin.from("attachments").select("id").eq("storage_path", path).maybeSingle();
    if (!existing) await admin.storage.from(BUCKET).remove([path]);
    return { error: message };
  };

  const targetError = await checkUploadTarget(workOrderId, meta);
  if (targetError) return discard(targetError);

  const stored = await storedObject(path);
  if (!stored) return { error: `${label} did not finish uploading. Try again.` };
  const bad = checkFile(label, stored.type, stored.size);
  if (bad) return discard(bad);

  const { error } = await admin.from("attachments").insert({
    work_order_id: workOrderId,
    component_id: meta.componentId,
    category: meta.category,
    storage_path: path,
    file_name: label,
    mime_type: stored.type,
    size_bytes: stored.size,
    note: meta.note?.trim().slice(0, 2000) || null,
    uploaded_by: profile.id,
    shop_visible: true,
  });
  if (error) {
    // A repeated register for the same path is already recorded: do not delete the file.
    if (error.code === "23505") return { ok: Date.now() };
    return discard(`${label} could not be saved. Try again.`);
  }
  revalidatePath("/shop");
  return { ok: Date.now() };
}
