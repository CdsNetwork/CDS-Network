/**
 * "Question Pending" (CDS, 2026-11-11): CDS's Google Sheet turned a row hot pink when Ryder
 * had a question CDS had to take to the shop and answer back. CDS switches the flag on and
 * off on the work order page; the work order list shows a pink badge on those rows and can
 * show only them. It never changes the status and shops never see it.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
const requireCds = vi.fn(async () => ({ id: "u1", kind: "cds", can_delete_work_orders: false }));
vi.mock("@/lib/auth", () => ({ requireCds }));
vi.mock("@/lib/qbo/tokens", () => ({ qboApi: vi.fn() }));

let rpcResult: { data: unknown; error: { message: string } | null };
const rpc = vi.fn(async () => rpcResult);
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc, from: vi.fn() })) }));

const { isQuestionPending, questionNote, questionTitle, QUESTION_NOTE_MAX, QUESTION_PARAM } = await import(
  "@/components/cds-wo/question-pending"
);
const { filterQuery, parseFilters } = await import("@/components/cds-wo/woFilters");
const { setQuestionPending } = await import("@/app/cds/work-orders/[id]/actions");

const WO = "11111111-1111-4111-8111-111111111111";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  rpc.mockClear();
  rpcResult = { data: null, error: null };
});

describe("isQuestionPending", () => {
  it("reads the embedded row as an object or an array", () => {
    expect(isQuestionPending({ question_pending: true })).toBe(true);
    expect(isQuestionPending([{ question_pending: true, note: null }])).toBe(true);
    expect(isQuestionPending({ question_pending: false })).toBe(false);
    expect(isQuestionPending([])).toBe(false);
    expect(isQuestionPending(null)).toBe(false);
    expect(isQuestionPending(undefined)).toBe(false);
  });
});

describe("questionTitle", () => {
  it("shows the note on the badge when there is one", () => {
    expect(questionTitle({ question_pending: true, note: "  Is the DPF reusable?  " })).toBe("Question: Is the DPF reusable?");
    expect(questionTitle({ question_pending: true, note: " " })).toMatch(/question is waiting/);
    expect(questionTitle({ question_pending: false, note: "old" })).toBeNull();
  });
});

describe("questionNote", () => {
  it("trims the note, saves an empty one as null, and refuses one that is too long", () => {
    expect(questionNote("  When can it ship?  ")).toEqual({ note: "When can it ship?" });
    expect(questionNote("   ")).toEqual({ note: null });
    expect(questionNote(null)).toEqual({ note: null });
    expect(questionNote("x".repeat(QUESTION_NOTE_MAX))).toEqual({ note: "x".repeat(QUESTION_NOTE_MAX) });
    expect(questionNote("x".repeat(QUESTION_NOTE_MAX + 1))).toHaveProperty("error");
  });
});

describe("Question Pending filter", () => {
  it("is read from the query string and kept in links and the CSV export", () => {
    expect(QUESTION_PARAM).toBe("question");
    const f = parseFilters({ question: "1", status: "in_progress" });
    expect(f.question).toBe(true);
    expect(filterQuery(f)).toContain("question=1");
    expect(parseFilters({}).question).toBe(false);
    expect(parseFilters({ question: "true" }).question).toBe(false);
    expect(filterQuery(parseFilters({}))).not.toContain("question");
  });

  it("combines with the New from shop filter", () => {
    const f = parseFilters({ question: "1", from_shop: "1" });
    expect(f).toMatchObject({ question: true, fromShop: true });
    expect(filterQuery(f)).toBe("?from_shop=1&question=1");
  });

  it("lists only orders whose question is pending", () => {
    const filters = read("src/components/cds-wo/woFilters.ts");
    expect(filters).toMatch(/from\("work_order_questions"\)[\s\S]*\.eq\("question_pending", true\)/);
  });
});

describe("CDS work order list", () => {
  const page = read("src/app/cds/page.tsx");

  it("loads the flag of each row and shows a pink badge and row", () => {
    expect(page).toMatch(/work_order_questions\(question_pending, note\)/);
    expect(page).toContain("Question Pending");
    expect(page).toMatch(/styles\.questionRow/);
    expect(page).toMatch(/styles\.questionBadge/);
    expect(page).toMatch(/name=\{QUESTION_PARAM\}/);
    const css = read("src/components/cds-wo/cds-wo.module.css");
    expect(css).toMatch(/\.questionBadge \{[^}]*background: #ff1493;/);
  });
});

describe("setQuestionPending", () => {
  it("switches the flag on with the note through the database function", async () => {
    const res = await setQuestionPending(WO, true, {}, form({ question_note: " Ryder asks for photos " }));
    expect(res.ok).toBe("Marked Question Pending.");
    expect(rpc).toHaveBeenCalledWith("cds_set_question_pending", { p_work_order: WO, p_pending: true, p_note: "Ryder asks for photos" });
  });

  it("switches it off without a note", async () => {
    const res = await setQuestionPending(WO, false, {}, form({ question_note: "ignored" }));
    expect(res.ok).toBe("Question Pending cleared.");
    expect(rpc).toHaveBeenCalledWith("cds_set_question_pending", { p_work_order: WO, p_pending: false, p_note: null });
  });

  it("refuses a note that is too long or a bad id without calling the database", async () => {
    expect(await setQuestionPending(WO, true, {}, form({ question_note: "x".repeat(QUESTION_NOTE_MAX + 1) }))).toHaveProperty("error");
    expect(await setQuestionPending("nope", true, {}, form({}))).toEqual({ error: "Work order not found." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns the database refusal", async () => {
    rpcResult = { data: null, error: { message: "Only CDS staff can do this" } };
    expect(await setQuestionPending(WO, true, {}, form({}))).toEqual({ error: "Only CDS staff can do this" });
  });
});

describe("Question Pending migration", () => {
  const sql = read("supabase/migrations/20261111070000_question_pending.sql");

  it("keeps the flag in a CDS-only table that nobody writes through the API", () => {
    expect(sql).toMatch(/create table public\.work_order_questions/);
    expect(sql).toMatch(/create policy cds_read on public\.work_order_questions for select to authenticated/);
    expect(sql).not.toMatch(/create policy shop_read/);
    expect(sql).toMatch(/grant select on table public\.work_order_questions to authenticated;/);
    expect(sql).toMatch(/perform private\.require_cds\(\);/);
  });

  it("writes an audit_log row on each change and never touches the status", () => {
    expect(sql).toMatch(/insert into public\.audit_log/);
    expect(sql).not.toMatch(/update public\.work_orders/);
  });

  it("uses no em or en dashes", () => {
    expect(sql).not.toMatch(/[\u2013\u2014]/);
    expect(read("src/components/cds-wo/question-pending.ts")).not.toMatch(/[\u2013\u2014]/);
  });
});
