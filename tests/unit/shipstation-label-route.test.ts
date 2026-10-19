/**
 * The label PDF route never serves a voided label (it is no longer shippable).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LABEL_ID = "00000000-0000-4000-8000-00000000a001";
let row: Record<string, unknown> | null = null;
const download = vi.fn(async () => ({ data: new Blob(["%PDF-1.4"], { type: "application/pdf" }), error: null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ download }) } }),
}));

const { GET } = await import("@/app/api/shipstation/label/[id]/route");
const call = () => GET(new Request(`http://localhost/api/shipstation/label/${LABEL_ID}`), { params: Promise.resolve({ id: LABEL_ID }) });

const base = {
  id: LABEL_ID,
  label_file_path: "wo/labels/x.pdf",
  label_url: "https://api.shipstation.com/v2/downloads/x.pdf",
  tracking_number: "794600000001",
  is_test: false,
};

describe("GET /api/shipstation/label/[id]", () => {
  beforeEach(() => download.mockClear());

  it("serves an active label's PDF", async () => {
    row = { ...base, status: "active" };
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("answers 410 for a voided label and never reads or redirects to the file", async () => {
    row = { ...base, status: "voided" };
    const res = await call();
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });
});
