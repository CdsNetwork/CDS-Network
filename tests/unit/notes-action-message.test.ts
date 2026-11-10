/**
 * Browser test 2026-11-10: on the CDS work order, adding an internal note and then deleting
 * one left "Internal note added." on screen and showed no delete message. The delete form
 * belongs to the deleted note, so it unmounts with it and its own message never shows; the
 * add form kept its old message. The notes sections now share one message: whichever action
 * finished last, reported from inside the action (not an effect, which never runs once the
 * form is gone).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actionMessage, latestActionState } from "@/components/cds-wo/action-message";

describe("latestActionState", () => {
  it("a delete after an add replaces the add message", () => {
    const added = { ok: "Internal note added.", at: 1 };
    const deleted = { ok: "Internal note deleted.", at: 2 };
    expect(actionMessage(latestActionState(added, deleted))).toEqual({ kind: "ok", text: "Internal note deleted." });
  });

  it("an error result replaces an earlier success", () => {
    expect(actionMessage(latestActionState({ ok: "Note added.", at: 1 }, { error: "Note not found." }))).toEqual({
      kind: "error",
      text: "Note not found.",
    });
  });

  it("shows nothing before any action ran", () => {
    expect(actionMessage({})).toBeNull();
  });
});

describe("notes sections share one message", () => {
  const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

  it("both notes sections on the CDS work order are wrapped in an ActionMessageGroup", () => {
    const page = read("app/cds/work-orders/[id]/page.tsx");
    for (const id of ["internal-notes", "notes"]) {
      const start = page.indexOf(`<section className="section" id="${id}">`);
      expect(start, id).toBeGreaterThan(-1);
      const section = page.slice(start, page.indexOf("</section>", start));
      expect(section, id).toContain("<ActionMessageGroup>");
      expect(section, id).toContain("</ActionMessageGroup>");
    }
  });

  it("ActionForm reports its result to the group from the action itself", () => {
    const form = read("components/cds-wo/ActionForm.tsx");
    expect(form).toContain("useContext(ActionMessageContext)");
    expect(form).toMatch(/group\?\.report\(result\)/);
  });
});
