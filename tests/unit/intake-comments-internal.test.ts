/**
 * Customer comments on a request template are free text and can carry things the shop must
 * not see (an agreed price, a note meant for CDS). They go to the CDS-only internal notes;
 * the shop-visible requested work is built from the structured services only.
 */
import { describe, expect, it, vi } from "vitest";
import { buildDraftParams } from "@/lib/intake/draft";
import type { LlmExtractor } from "@/lib/intake/llm";
import { parseEmail } from "@/lib/intake/parse";
import { DPF_CLEAN, reference } from "../fixtures/intake/reference";
import * as t from "../fixtures/intake/templates";

const EMAIL_ID = "00000000-0000-4000-8000-0000000e0450";
const SECRET = "Agreed customer price $450. Keep this price internal.";

describe("customer comments from an intake template", () => {
  it("stay out of the shop-visible requested work and land in the CDS-only internal notes", async () => {
    const email = { ...t.ryderDpfClamps, html: t.ryderDpfClamps.html!.replace("Filter is on the rack by bay 2", SECRET) };
    const llm = vi.fn<LlmExtractor>();
    const p = await parseEmail(email, reference(), { llm });
    expect(llm).not.toHaveBeenCalled();
    expect(p.fields.comments?.value).toBe(SECRET);

    const work = p.fields.requested_work.value ?? "";
    expect(work).toContain(DPF_CLEAN.name);
    expect(work).toMatch(/DPF Clamps and Gaskets.*kit to be chosen by CDS/);
    expect(work).not.toContain("$450");
    expect(work).not.toMatch(/internal|Customer comments/i);

    const d = buildDraftParams(EMAIL_ID, email, p);
    if (!d.ok) throw new Error(d.reason);
    expect(d.params.p_requested_work).not.toContain("$450");
    expect(d.params.p_requested_work).not.toMatch(/Customer comments/i);
    expect(d.params.p_internal_notes).toContain(`Customer comments: ${SECRET}`);
  });
});
