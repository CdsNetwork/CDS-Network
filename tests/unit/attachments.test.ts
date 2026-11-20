import { describe, expect, it } from "vitest";
import {
  cdsRemoveConfirm,
  checkFile,
  checkMeta,
  isUploadPathFor,
  MAX_UPLOAD_BYTES,
  precheckFile,
  photoLeftFor,
  safeName,
  shopCanRemove,
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

describe("uploaderLabel", () => {
  it("names CDS staff, else the shop", () => {
    expect(uploaderLabel({ full_name: "Ashley", kind: "cds" }, null)).toBe("CDS (Ashley)");
    expect(uploaderLabel({ full_name: null, kind: "cds" }, "Shop A")).toBe("CDS");
    expect(uploaderLabel({ full_name: "Shop login", kind: "shop" }, "Shop A")).toBe("Shop A");
    expect(uploaderLabel({ full_name: "Shop login", kind: "shop" }, null)).toBe("Shop login");
    expect(uploaderLabel(null, "Shop A")).toBe("Shop A");
    expect(uploaderLabel(null, null)).toBe("-");
  });
});

describe("shopCanRemove", () => {
  const own = { fromCds: false, uploadedBy: UUID };
  it("lets a shop remove its own upload while accepted, picked up or in process", () => {
    for (const status of ["accepted", "picked_up", "in_process"]) expect(shopCanRemove(status, own), status).toBe(true);
  });
  it("not before acceptance, and not once the job is completed or later", () => {
    for (const status of ["awaiting_acceptance", "completed", "delivered", "ready_to_invoice", "invoiced", "cancelled"]) {
      expect(shopCanRemove(status, own), status).toBe(false);
    }
  });
  it("never a CDS file or a file recorded without a person", () => {
    expect(shopCanRemove("in_process", { fromCds: true, uploadedBy: UUID })).toBe(false);
    expect(shopCanRemove("in_process", { fromCds: false, uploadedBy: null })).toBe(false);
  });
});

describe("photoLeftFor and cdsRemoveConfirm", () => {
  const dpf = { id: "c1", component_type: "DPF", result: "condemned", seq: 1 };
  const egr = { id: "c2", component_type: "EGR", result: "condemned", seq: 2 };
  const doc = { id: "c3", component_type: "DOC", result: "cleaned", seq: 3 };
  const files = [
    { id: "f1", component_id: "c1" },
    { id: "f2", component_id: "c2" },
    { id: "f3", component_id: "c3" },
    { id: "f4", component_id: null },
  ];
  const comps = [dpf, egr, doc];

  it("names the condemned DPF, DOC or SCR left without a photo on a completed order", () => {
    for (const status of ["completed", "delivered", "ready_to_invoice", "invoiced"]) {
      expect(photoLeftFor("f1", files, comps, status), status).toBe("DPF #1");
    }
    expect(photoLeftFor("f1", files, [{ ...dpf, component_type: "SCR" }], "completed")).toBe("SCR #1");
    expect(photoLeftFor("f1", files, [{ ...dpf, component_type: "DOC" }], "completed")).toBe("DOC #1");
  });

  it("is quiet before completion, when another photo stays, for an EGR cooler, a part not condemned, or no component", () => {
    expect(photoLeftFor("f1", files, comps, "in_process")).toBeNull();
    expect(photoLeftFor("f1", [...files, { id: "f5", component_id: "c1" }], comps, "completed")).toBeNull();
    expect(photoLeftFor("f2", files, comps, "completed")).toBeNull();
    expect(photoLeftFor("f3", files, comps, "completed")).toBeNull();
    expect(photoLeftFor("f4", files, comps, "completed")).toBeNull();
  });

  it("names the file, and adds the warning when a required photo goes", () => {
    expect(cdsRemoveConfirm("wrong.png", null)).toBe("Remove wrong.png from this work order? The file is deleted for good.");
    const warned = cdsRemoveConfirm("wrong.png", "DPF #1");
    expect(warned).toContain("Remove wrong.png from this work order?");
    expect(warned).toMatch(/only photo of the condemned DPF #1/);
    expect(warned).not.toMatch(/[\u2013\u2014]/);
  });
});
