import { describe, expect, it } from "vitest";
import {
  cdsCanDelete,
  checkFile,
  checkMeta,
  isUploadPathFor,
  MAX_UPLOAD_BYTES,
  precheckFile,
  safeName,
  storedNote,
  uploaderLabel,
  uploadPath,
} from "@/lib/attachments";

const WO = "11111111-2222-4333-8444-555555555555";
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("safeName", () => {
  it("keeps letters, digits, dot, dash and underscore", () => {
    expect(safeName("Unit 42 photo (1).JPG")).toBe("Unit_42_photo_1_.JPG");
    expect(safeName("..hidden")).toBe("hidden");
    expect(safeName("???")).toBe("file");
    expect(safeName(`${"a".repeat(150)}.pdf`)).toHaveLength(100);
  });
});

describe("checkFile and precheckFile", () => {
  it("accepts photos and PDFs up to 25 MB", () => {
    expect(checkFile("a.jpg", "image/jpeg", 10)).toBeNull();
    expect(checkFile("a.pdf", "application/pdf", MAX_UPLOAD_BYTES)).toBeNull();
    expect(precheckFile({ type: "image/heic", size: 1 })).toBeNull();
  });
  it("refuses other types, empty files and files over 25 MB", () => {
    expect(checkFile("a.txt", "text/plain", 10)).toMatch(/only photos/);
    expect(checkFile("a.svg", "image/svg+xml", 10)).toMatch(/only photos/);
    expect(checkFile("a.jpg", "image/jpeg", 0)).toMatch(/empty/);
    expect(checkFile("a.jpg", "image/jpeg", MAX_UPLOAD_BYTES + 1)).toMatch(/25 MB/);
    expect(precheckFile({ type: "text/plain", size: 1 })).toMatch(/only photos/);
    expect(precheckFile({ type: "image/png", size: MAX_UPLOAD_BYTES + 1 })).toMatch(/25 MB/);
  });
});

describe("checkMeta", () => {
  const ok = { category: "other", componentId: null, note: null };
  it("accepts the known categories and an optional shop visibility flag", () => {
    expect(checkMeta(ok)).toBeNull();
    expect(checkMeta({ ...ok, category: "completed_work", note: "x", shopVisible: false })).toBeNull();
  });
  it("refuses an unknown category, including inherited object keys", () => {
    expect(checkMeta({ ...ok, category: "invoice" })).toBe("Choose a category.");
    expect(checkMeta({ ...ok, category: "toString" })).toBe("Choose a category.");
    expect(checkMeta(null as never)).toBe("Choose a category.");
  });
  it("refuses a visibility flag that is not true or false", () => {
    expect(checkMeta({ ...ok, shopVisible: "yes" as never })).toMatch(/shop can see/);
  });
});

describe("upload paths", () => {
  it("builds a path in the work order's folder that passes the check", () => {
    const path = uploadPath(WO, UUID, "Unit 42.jpg");
    expect(path).toBe(`${WO}/${UUID}-Unit_42.jpg`);
    expect(isUploadPathFor(WO, path)).toBe(true);
    expect(isUploadPathFor(WO.toUpperCase(), path)).toBe(true);
  });
  it("refuses another work order's folder and other shapes", () => {
    const other = "99999999-2222-4333-8444-555555555555";
    expect(isUploadPathFor(other, uploadPath(WO, UUID, "a.jpg"))).toBe(false);
    expect(isUploadPathFor(WO, `${WO}/a.jpg`)).toBe(false);
    expect(isUploadPathFor(WO, `${WO}/${UUID}-../x`)).toBe(false);
    expect(isUploadPathFor(WO, null)).toBe(false);
  });
});

describe("storedNote", () => {
  it("trims, caps at 2000 characters and stores empty as null", () => {
    expect(storedNote("  hi  ")).toBe("hi");
    expect(storedNote("   ")).toBeNull();
    expect(storedNote(null)).toBeNull();
    expect(storedNote("x".repeat(2500))).toHaveLength(2000);
  });
});

describe("uploaderLabel and cdsCanDelete", () => {
  it("names CDS staff, else the shop", () => {
    expect(uploaderLabel({ full_name: "Ashley", kind: "cds" }, null)).toBe("CDS (Ashley)");
    expect(uploaderLabel({ full_name: null, kind: "cds" }, "Shop A")).toBe("CDS");
    expect(uploaderLabel({ full_name: "Shop login", kind: "shop" }, "Shop A")).toBe("Shop A");
    expect(uploaderLabel({ full_name: "Shop login", kind: "shop" }, null)).toBe("Shop login");
    expect(uploaderLabel(null, "Shop A")).toBe("Shop A");
    expect(uploaderLabel(null, null)).toBe("-");
  });
  it("lets CDS delete only files CDS staff added", () => {
    expect(cdsCanDelete({ full_name: "Ashley", kind: "cds" })).toBe(true);
    expect(cdsCanDelete({ full_name: "Shop", kind: "shop" })).toBe(false);
    expect(cdsCanDelete(null)).toBe(false);
  });
});
