import "server-only";
import { randomUUID } from "node:crypto";
import { ATTACHMENT_BUCKET, uploadPath, type PrepareResult } from "@/lib/attachments";

// Storage side of the two-step upload used by shops and CDS. Files go straight from the
// browser to storage, so large photos never pass through a server action (Next.js and
// Vercel cap request bodies). Callers check the user and the work order first.

/** Loaded on use, so importing the server actions does not need the service key (unit tests). */
async function adminClient() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

/** A one-time signed upload URL token for a new path in this work order's folder. */
export async function signedUploadTarget(workOrderId: string, fileName: string): Promise<PrepareResult> {
  const path = uploadPath(workOrderId, randomUUID(), fileName);
  const { data, error } = await (await adminClient()).storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { error: `${fileName} could not be prepared for upload. Try again.` };
  return { path: data.path, token: data.token };
}

/** Real size and type of a stored object, from storage metadata. */
export async function storedObject(path: string): Promise<{ size: number; type: string } | null> {
  const bucket = (await adminClient()).storage.from(ATTACHMENT_BUCKET);
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

/**
 * Removes an uploaded object that was not recorded, unless it is already recorded (a
 * replayed request must never delete a file that belongs to an existing attachment).
 */
export async function discardUnrecorded(path: string): Promise<void> {
  const admin = await adminClient();
  const { data: existing } = await admin.from("attachments").select("id").eq("storage_path", path).maybeSingle();
  if (!existing) await admin.storage.from(ATTACHMENT_BUCKET).remove([path]);
}
