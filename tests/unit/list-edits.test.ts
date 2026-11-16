/**
 * Work order list editing (Sarah, CDS, 2026-11-13; milestone M3): CDS changes an order's
 * status and internal status and reads, adds and edits notes from the dashboard list, with
 * the same rules as on the work order page.
 */
import { describe, expect, it } from "vitest";
import { listStatusMoves, popoverNotes, type NoteRow } from "@/components/cds-wo/list-edits";
import { ORDER_CREATED_NOTE_ID } from "@/lib/notes";

const moves = (status: string, locked = false) => listStatusMoves(status, locked).map((m) => m.status);

describe("status moves offered in the list", () => {
  it("offers the same moves as the work order page", () => {
    expect(moves("completed")).toEqual(["delivered", "ready_to_invoice", "cancelled"]);
    expect(moves("delivered")).toEqual(["ready_to_invoice", "cancelled"]);
    expect(moves("awaiting_acceptance")).toEqual(["pending_review", "cancelled"]);
    for (const s of ["pending_review", "accepted", "picked_up", "in_process", "ready_to_invoice", "rejected_by_affiliate"]) {
      expect(moves(s), s).toEqual(["cancelled"]);
    }
  });

  it("offers nothing on a cancelled or invoiced order", () => {
    expect(moves("cancelled")).toEqual([]);
    expect(moves("invoiced")).toEqual([]);
  });

  it("does not offer cancel once a QuickBooks invoice exists", () => {
    expect(moves("in_process", true)).toEqual([]);
    expect(moves("completed", true)).toEqual(["delivered", "ready_to_invoice"]);
  });

  it("asks before cancelling or sending back to review, as the order page does", () => {
    const byStatus = Object.fromEntries(
      [...listStatusMoves("completed", false), ...listStatusMoves("awaiting_acceptance", false)].map((m) => [m.status, m]),
    );
    expect(byStatus.cancelled.confirm).toBe("Cancel this work order? The shop will see that it was cancelled.");
    expect(byStatus.pending_review.confirm).toBe("Take this order back from the shop and return it to review?");
    expect(byStatus.delivered.confirm).toBeUndefined();
    expect(byStatus.ready_to_invoice.confirm).toBeUndefined();
  });
});

describe("notes popover data", () => {
  const row = (id: string, author_id: string | null, extra: Partial<NoteRow> = {}): NoteRow => ({
    id,
    author_id,
    author_name: `Author ${id}`,
    created_at: `2026-11-1${id.length}T10:00:00Z`,
    body: `Body ${id}`,
    ...extra,
  });

  it("starts the internal notes with the text written when the order was created, like the order page", () => {
    const out = popoverNotes({
      createdText: "  From the intake email\r\n",
      orderCreatedAt: "2026-11-01T08:00:00Z",
      internal: [row("a", "me")],
      shared: [],
      me: "me",
    });
    expect(out.internal.map((n) => n.id)).toEqual([ORDER_CREATED_NOTE_ID, "a"]);
    expect(out.internal[0]).toMatchObject({ body: "From the intake email", editable: false, edited_at: null });
  });

  it("lets CDS edit only its own internal notes", () => {
    const out = popoverNotes({
      createdText: null,
      orderCreatedAt: "2026-11-01T08:00:00Z",
      internal: [row("a", "me"), row("b", "someone-else"), row("c", null)],
      shared: [],
      me: "me",
    });
    expect(out.internal.map((n) => [n.id, n.editable])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
  });

  it("never offers editing a note the shop sees", () => {
    const out = popoverNotes({
      createdText: null,
      orderCreatedAt: "2026-11-01T08:00:00Z",
      internal: [],
      shared: [row("s", "me")],
      me: "me",
    });
    expect(out.shared).toEqual([expect.objectContaining({ id: "s", editable: false })]);
  });

  it("keeps the edit time when the database has one, and null before", () => {
    const out = popoverNotes({
      createdText: "",
      orderCreatedAt: "2026-11-01T08:00:00Z",
      internal: [row("a", "me", { edited_at: "2026-11-16T12:00:00Z" }), row("b", "me")],
      shared: [],
      me: "me",
    });
    expect(out.internal.map((n) => n.edited_at)).toEqual(["2026-11-16T12:00:00Z", null]);
  });

  it("drops fields the popover does not need (author ids stay on the server)", () => {
    const out = popoverNotes({
      createdText: null,
      orderCreatedAt: "2026-11-01T08:00:00Z",
      internal: [row("a", "me", { work_order_id: "w" } as Partial<NoteRow>)],
      shared: [row("s", "x", { affiliate_id: "shop" } as Partial<NoteRow>)],
      me: "me",
    });
    expect(Object.keys(out.internal[0]).sort()).toEqual(["author_name", "body", "created_at", "editable", "edited_at", "id"]);
    expect(Object.keys(out.shared[0]).sort()).toEqual(["author_name", "body", "created_at", "editable", "edited_at", "id"]);
  });
});
