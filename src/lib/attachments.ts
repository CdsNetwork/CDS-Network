// Rules for work order files, shared by the shop and the CDS upload flows (server and
// browser). Pure: no database or storage access here.

import { ATTACHMENT_CATEGORY_LABEL } from "@/lib/format";

export const ATTACHMENT_BUCKET = "wo-files";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ALLOWED_UPLOAD_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

/** What the form sends with each file. shopVisible is only read on the CDS side. */
export type UploadMeta = {
  category: string;
  componentId: string | null;
  note: string | null;
  shopVisible?: boolean;
};
export type DeclaredFile = { name: string; type: string; size: number };
export type PrepareResult = { error: string } | { path: string; token: string };

/** A storage-safe file name: letters, digits, dot, dash and underscore, at most 100 characters. */
export function safeName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "");
  return (cleaned || "file").slice(-100);
}

/** Type and size check, for the declared file and again for the stored object. */
export function checkFile(name: string, type: string, size: number): string | null {
  if (!ALLOWED_UPLOAD_MIME.has(type)) return `${name}: only photos (JPG, PNG, HEIC, WebP, GIF) and PDF files can be added.`;
  if (!(size > 0)) return `${name} is empty.`;
  if (size > MAX_UPLOAD_BYTES) return `${name} is larger than 25 MB.`;
  return null;
}

/** Client-side check only, for a quick answer. The server checks again before and after. */
export function precheckFile(f: { type: string; size: number }): string | null {
  if (!(f.type.startsWith("image/") || f.type === "application/pdf")) return "only photos and PDF files can be added.";
  if (f.size > MAX_UPLOAD_BYTES) return "larger than 25 MB.";
  return null;
}

/** The checks on the form fields that need no database. */
export function checkMeta(meta: UploadMeta): string | null {
  if (!meta || typeof meta !== "object") return "Choose a category.";
  if (!Object.prototype.hasOwnProperty.call(ATTACHMENT_CATEGORY_LABEL, meta.category)) return "Choose a category.";
  if (meta.componentId !== null && typeof meta.componentId !== "string") return "Component not found";
  if (meta.note !== null && typeof meta.note !== "string") return "The note is not valid.";
  if (meta.shopVisible !== undefined && typeof meta.shopVisible !== "boolean") return "Choose whether the shop can see the file.";
  return null;
}

/** The note as stored: trimmed, at most 2000 characters, empty becomes null. */
export function storedNote(note: string | null): string | null {
  return note?.trim().slice(0, 2000) || null;
}

/** Folder path for a new upload: '<work order id>/<random uuid>-<safe name>'. */
export function uploadPath(workOrderId: string, uuid: string, fileName: string): string {
  return `${workOrderId}/${uuid}-${safeName(fileName)}`;
}

const PATH_RE = /^([0-9a-f-]{36})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$/i;

/** True when the path has the shape uploadPath makes and sits in this work order's folder. */
export function isUploadPathFor(workOrderId: string, path: unknown): boolean {
  const m = typeof path === "string" ? PATH_RE.exec(path) : null;
  return Boolean(m && m[1].toLowerCase() === String(workOrderId).toLowerCase());
}

/** Who added a file, as CDS sees it. */
export type Uploader = { full_name: string | null; kind: string | null } | null;

export function uploaderLabel(uploader: Uploader, shopName: string | null): string {
  if (uploader?.kind === "cds") return uploader.full_name ? `CDS (${uploader.full_name})` : "CDS";
  if (uploader?.kind === "shop") return shopName ?? uploader.full_name ?? "Shop";
  return shopName ?? "-";
}

/** CDS may delete only files CDS staff uploaded; shop files stay as the shop's record. */
export function cdsCanDelete(uploader: Uploader): boolean {
  return uploader?.kind === "cds";
}
