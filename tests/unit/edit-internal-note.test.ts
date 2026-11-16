/**
 * Editing a CDS-only internal note from the work order list (milestone M3). The database
 * function public.cds_edit_internal_note (20261117020000_edit_internal_notes.sql) checks the
 * author and logs the change; the action checks the input the same way adding a note does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCds: vi.fn(async () => ({ id: "u1", kind: "cds" })) }));

const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));

const { editInternalNote } = await import("@/app/cds/notes-actions");

const WO = "11111111-1111-4111-8111-111111111111";
const NOTE = "22222222-2222-4222-8222-222222222222";

function form(body: string): FormData {
  const fd = new FormData();
  fd.set("body", body);
  return fd;
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ error: null });
});

describe("editInternalNote", () => {
  it("saves the trimmed text through the database function", async () => {
    const res = await editInternalNote(WO, NOTE, {}, form("  Called the customer.\r\nETA Friday.  "));
    expect(rpc).toHaveBeenCalledWith("cds_edit_internal_note", { p_note: NOTE, p_body: "Called the customer.\nETA Friday." });
    expect(res.ok).toBe("Note saved.");
  });

  it("refuses an empty or too long note without calling the database", async () => {
    expect((await editInternalNote(WO, NOTE, {}, form("   "))).error).toBe("Write a note first.");
    expect((await editInternalNote(WO, NOTE, {}, form("x".repeat(2001)))).error).toMatch(/too long/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses ids that are not notes", async () => {
    expect((await editInternalNote(WO, "order-created", {}, form("x"))).error).toBe("Note not found.");
    expect((await editInternalNote("nope", NOTE, {}, form("x"))).error).toBe("Note not found.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shows the database's refusal", async () => {
    rpc.mockResolvedValue({ error: { message: "Only the author can edit a note" } });
    expect((await editInternalNote(WO, NOTE, {}, form("x"))).error).toBe("Only the author can edit a note");
  });
});
