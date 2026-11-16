/**
 * Shop job page quick wins: confirmation after each action, stale errors cleared, "Not saved
 * yet" on edited component cards, a short page before acceptance, the next step as primary,
 * measurement inputs that accept any decimal, and small accessibility and tap-target fixes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { doneNotice } from "@/components/shop/types";

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("action feedback", () => {
  const form = src("components/shop/ActionForm.tsx");
  const detail = src("components/shop/JobDetail.tsx");

  it("ActionForm shows a role=status message on success, Saved. by default", () => {
    expect(form).toMatch(/successText = "Saved\."/);
    expect(form).toMatch(/role="status"/);
  });

  it("a later success anywhere on the page hides an old error", () => {
    expect(form).toMatch(/dispatchEvent\(new Event\(SAVED_EVENT\)\)/);
    expect(form).toMatch(/addEventListener\(SAVED_EVENT/);
  });

  it("each shop action names its outcome", () => {
    expect(detail).toMatch(/submitLabel="Accept Work"[^>]*successText="Job accepted\. CDS was notified\."/);
    expect(detail).toMatch(/submitLabel="Picked Up"[^>]*pendingLabel="Marking picked up\.\.\."[^>]*successText="Marked picked up\."/);
    expect(detail).toMatch(/submitLabel="In Process"[^>]*pendingLabel="Marking in process\.\.\."[^>]*successText="Marked in process\."/);
    expect(detail).toMatch(/submitLabel="Complete Work"[^>]*successText="Job completed\. CDS was notified\."/);
    expect(detail).toMatch(/submitLabel="Add note"[^>]*successText="Note added\."/);
  });

  it("status changes return to the job with a notice that survives the re-render", () => {
    // The form unmounts when the status changes, so the redirect runs in the action itself,
    // not in an effect after the result (seen on TEST 2026-11-17: no notice after Accept).
    expect(form).toMatch(/if \(result\.ok && successHref\) router\.replace\(successHref\);/);
    expect(form).not.toMatch(/useEffect\([^]*?if \(successHref\) router\.replace/);
    expect(detail).toMatch(/successHref=\{doneHref\("accepted"\)\}/);
    expect(detail).toMatch(/successHref=\{doneHref\("completed"\)\}/);
    expect(src("app/shop/page.tsx")).toMatch(/done=\{one\(params\.done\)\}/);
  });

  it("doneNotice words the outcome and ignores a stale or unknown value", () => {
    expect(doneNotice("accepted", "accepted")).toBe("Job accepted. CDS was notified.");
    expect(doneNotice("picked_up", "picked_up")).toBe("Marked picked up.");
    expect(doneNotice("in_process", "in_process")).toBe("Marked in process.");
    expect(doneNotice("completed", "completed")).toBe("Job completed. CDS was notified.");
    expect(doneNotice("completed", "in_process")).toBeNull();
    expect(doneNotice("accepted", "awaiting_acceptance")).toBeNull();
    expect(doneNotice("other", "accepted")).toBeNull();
    expect(doneNotice(undefined, "accepted")).toBeNull();
  });
});

describe("component card", () => {
  const card = src("components/shop/ComponentCard.tsx");

  it("says Not saved yet after an edit until the card is saved", () => {
    expect(card).toMatch(/Not saved yet/);
    expect(card).toMatch(/onChange=\{\(\) => setDirty\(true\)\}/);
    expect(card).toMatch(/onSuccess=\{\(\) => setDirty\(false\)\}/);
  });

  it("measurement inputs accept any decimal and never use min 0.1", () => {
    expect(card).not.toMatch(/step="0\.0?1"/);
    expect(card).not.toMatch(/min="0\.1"/);
    expect(card).toMatch(/step="any"/);
  });
});

describe("job page before and after acceptance", () => {
  const detail = src("components/shop/JobDetail.tsx");

  it("work sections render only once the job is accepted", () => {
    const gate = detail.indexOf("{!awaiting && (");
    expect(gate).toBeGreaterThan(-1);
    for (const heading of ["<h3>Notes</h3>", "<h3>Services & Parts Used</h3>", "<h3>Request Additional Authorization</h3>", "<h3>Photos & Attachments</h3>", "<h3>Components Received</h3>", "<h3>Complete work</h3>"]) {
      expect(detail.indexOf(heading), heading).toBeGreaterThan(gate);
    }
    expect(detail.indexOf("<h3>Settlement preview</h3>")).toBeLessThan(gate);
  });

  it("Decline is a small text button after acceptance", () => {
    expect(detail).toMatch(/<DeclineJob action=\{declineJob\.bind\(null, id\)\} small=\{!awaiting\} \/>/);
    expect(src("components/shop/DeclineJob.tsx")).toMatch(/small \?/);
  });

  it("the next step is the primary button", () => {
    expect(detail).toMatch(/submitLabel="Picked Up"[^>]*submitClass="btn btn-primary"/);
    expect(detail).toMatch(/submitClass=\{nextIsPickup \? "btn btn-secondary" : "btn btn-primary"\}/);
  });
});

describe("small accessibility and tap-target fixes", () => {
  it("emoji are hidden from screen readers", () => {
    const detail = src("components/shop/JobDetail.tsx");
    expect(detail).toMatch(/<span aria-hidden="true">📦<\/span>/);
    expect(detail).toMatch(/<span aria-hidden="true">🚚<\/span>/);
  });

  it("Request type is not a label without a control", () => {
    expect(src("components/shop/AuthRequestForm.tsx")).not.toMatch(/<label>Request type<\/label>/);
  });

  it("the shop error page has a styled button and a next step", () => {
    const page = src("app/shop/error.tsx");
    expect(page).toMatch(/className="btn btn-primary"/);
    expect(page).toMatch(/If it keeps happening, call CDS\./);
  });

  it("shop buttons, inputs and selects are 44px tall on phones", () => {
    const css = src("components/shop/shop.module.css");
    expect(css).toMatch(/\.shopPage :global\(\.btn\)[\s\S]*?min-height: 44px/);
    expect(src("app/shop/layout.tsx")).toMatch(/styles\.shopPage/);
  });
});
