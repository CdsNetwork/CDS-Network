import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { internalNotesHistory, ORDER_CREATED_NOTE_ID, type NoteView } from "@/lib/notes";

const CREATED = "2026-11-01T16:00:00Z";
const later: NoteView[] = [
  { id: "a", author_name: "Ashley", created_at: "2026-11-02T16:00:00Z", body: "Called the customer." },
  { id: "b", author_name: "Clyde", created_at: "2026-11-03T16:00:00Z", body: "Ship Friday." },
];

describe("internalNotesHistory", () => {
  it("shows the notes written with the order first, dated with the order, then the later notes", () => {
    expect(internalNotesHistory("  Rush order.\r\nCall before pickup.  ", CREATED, later)).toEqual([
      { id: ORDER_CREATED_NOTE_ID, author_name: "When the order was created", created_at: CREATED, body: "Rush order.\nCall before pickup." },
      ...later,
    ]);
  });

  it("leaves out an empty or missing order note", () => {
    for (const value of [null, undefined, "", "  \r\n\t "]) {
      expect(internalNotesHistory(value, CREATED, later), JSON.stringify(value)).toEqual(later);
    }
    expect(internalNotesHistory(null, CREATED, [])).toEqual([]);
  });

  it("shows only the order note when no notes were added later", () => {
    expect(internalNotesHistory("Only note", CREATED, [])).toEqual([
      { id: ORDER_CREATED_NOTE_ID, author_name: "When the order was created", created_at: CREATED, body: "Only note" },
    ]);
  });
});

describe("internal notes stay CDS only in the app", () => {
  const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));
  const filesUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? filesUnder(full) : [full];
    });

  it("no shop page or shop component reads work_order_internal_notes", () => {
    const shopFiles = [...filesUnder(join(srcDir, "app/shop")), ...filesUnder(join(srcDir, "components/shop"))];
    expect(shopFiles.length).toBeGreaterThan(0);
    for (const f of shopFiles) expect(readFileSync(f, "utf8"), f).not.toMatch(/work_order_internal_notes|InternalNote/);
  });

  it("the CDS work order page shows the history once, with the helper line", () => {
    const page = readFileSync(join(srcDir, "app/cds/work-orders/[id]/page.tsx"), "utf8");
    expect(page).toContain('.from("work_order_internal_notes")');
    expect(page).toContain("Only CDS staff see these notes. Shops never do.");
    expect(page).not.toContain('<Fact label="Internal notes">');
  });
});
