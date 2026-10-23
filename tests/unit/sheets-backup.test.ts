/**
 * Google Sheets backup: one row per work order keyed by WO number, header written and
 * repaired, rows rewritten in place, no duplicates on rerun, watermark, daily full resync,
 * nothing at all when not configured. A fake SheetsClient keeps the grid in memory.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER, toRow, type BackupOrder, type Cell } from "@/lib/sheets/columns";
import { sheetsConfig } from "@/lib/sheets/config";
import { googleSheetsClient, serviceAccountAssertion } from "@/lib/sheets/google";
import { FULL_EVERY_MS, OVERLAP_MS, rowsFromNote, runBackup, runRow, TAB, type BackupRun, type LastRuns, type SheetsClient } from "@/lib/sheets/sync";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("no database in this test");
  },
}));

/** In-memory tab: rows of cells, a grid size, and a log of calls. */
class FakeSheets implements SheetsClient {
  grid: unknown[][] = [];
  rowCount = 1000;
  columnCount = 26;
  exists = false;
  calls: string[] = [];
  async ensureTab(title: string) {
    expect(title).toBe(TAB);
    if (!this.exists) {
      this.calls.push("addTab");
      this.exists = true;
    }
    return { sheetId: 7, rowCount: this.rowCount, columnCount: this.columnCount };
  }
  async read(range: string) {
    expect(range).toBe(`'${TAB}'!A1:AE`);
    let last = this.grid.length;
    while (last > 0 && (this.grid[last - 1] ?? []).every((c) => c === "" || c === undefined)) last--;
    return this.grid.slice(0, last).map((r) => {
      const row = [...(r ?? [])];
      while (row.length && (row[row.length - 1] === "" || row[row.length - 1] === undefined)) row.pop();
      return row;
    });
  }
  async write(data: { range: string; values: Cell[][] }[]) {
    this.calls.push(`write ${data.map((d) => d.range.split("!")[1]).join(",")}`);
    for (const d of data) {
      const m = /!A(\d+):([A-Z]+)(\d+)$/.exec(d.range)!;
      const first = Number(m[1]);
      if (Number(m[3]) > this.rowCount) throw new Error("exceeds grid limits");
      d.values.forEach((v, i) => (this.grid[first - 1 + i] = [...v]));
    }
  }
  async grow(_id: number, rows: number, columns: number) {
    this.calls.push(`grow ${rows} ${columns}`);
    this.rowCount += rows;
    this.columnCount += columns;
  }
  async deleteRows(_id: number, indexes: number[]) {
    this.calls.push(`delete ${indexes.join(",")}`);
    for (const i of [...indexes].sort((a, b) => b - a)) this.grid.splice(i, 1);
  }
}

const order = (n: number, extra: Partial<BackupOrder> = {}): BackupOrder => ({
  woNumber: n,
  createdAt: "2026-10-20T17:00:00Z",
  status: "awaiting_acceptance",
  customer: "Ryder",
  locationCode: "1003-FREMONT",
  location: "FREMONT",
  shop: "Divine Heat Transfer",
  unitNumber: `U-${n}`,
  poNumber: "PO-1",
  vin: null,
  mileage: null,
  requestedWork: "Clean DPF",
  dispatchedAt: "2026-10-20T18:00:00Z",
  pickedUpAt: null,
  completedAt: null,
  deliveredAt: null,
  shopInvoiceRef: null,
  supplierCostTbd: false,
  invoiceNumber: null,
  invoicedAt: null,
  updatedAt: "2026-10-20T18:00:00Z",
  lines: [{ sku: "SVC-DPF", name: "DPF Cleaning", qty: 1, shopUnitRate: 230, customerUnitPrice: 335 }],
  components: [],
  shipments: [],
  ...extra,
});

/** Runs against an in-memory store of runs, like integration_sync. */
function harness(orders: BackupOrder[], sheets = new FakeSheets()) {
  const runs: BackupRun[] = [];
  let now = Date.parse("2026-10-23T12:00:00Z");
  const loads: (string | null)[] = [];
  const deps = {
    sheets,
    lastRuns: async (): Promise<LastRuns> => {
      const ok = runs.filter((r) => r.status === "ok");
      return {
        watermark: ok.at(-1)?.startedAt ?? null,
        lastFullAt: ok.filter((r) => r.full).at(-1)?.startedAt ?? null,
      };
    },
    loadOrders: async (since: string | null) => {
      loads.push(since);
      return since === null ? orders : orders.filter((o) => o.updatedAt >= since);
    },
    recordRun: async (r: BackupRun) => void runs.push(r),
    now: () => now,
  };
  return {
    sheets,
    runs,
    loads,
    run: (full?: boolean) => runBackup(deps, { full }),
    advance: (ms: number) => (now += ms),
    nowIso: () => new Date(now).toISOString(),
  };
}

const keys = (s: FakeSheets) => s.grid.slice(1).map((r) => r[0]);

describe("toRow", () => {
  it("fills the CDS columns, with money as numbers and TBD when the supplier cost is not known", () => {
    const o = order(100123, {
      vin: "1FUJ",
      mileage: 12345,
      components: [
        { type: "DPF", manufacturer: "Cummins", partNumber: "A123", weightRemovedG: 150.5, result: "cleaned", resultNote: null },
        { type: "DOC", manufacturer: "Cummins", partNumber: "B456", weightRemovedG: 20, result: "condemned", resultNote: "cracked" },
        { type: "EGR", manufacturer: null, partNumber: null, weightRemovedG: null, result: "passed", resultNote: null },
      ],
      shipments: [{ carrier: "UPS", trackingNumber: "1Z9", status: "in_transit", cost: 25 }],
      invoiceNumber: "1042",
    });
    const row = Object.fromEntries(HEADER.map((h, i) => [h, toRow(o)[i]]));
    expect(row["WO #"]).toBe(100123);
    expect(row["DATE"]).toBe("2026-10-20");
    expect(row["STATUS"]).toBe("Awaiting Affiliate Acceptance");
    expect(row["LICENSEE"]).toBe("Divine Heat Transfer");
    expect(row["Service/ Parts"]).toBe("1 x SVC-DPF DPF Cleaning");
    expect(row["PART NUMBER"]).toBe("A123; B456");
    expect(row["FILTER MFG"]).toBe("Cummins");
    expect(row["FILTER QTY"]).toBe(2);
    expect(row["Total Soot Remvd (g)"]).toBe(170.5);
    expect(row["FAIL"]).toBe("DOC Condemned: cracked");
    expect(row["SHIPPING INFO"]).toBe("UPS 1Z9 In Transit");
    expect(row["Shipping cost"]).toBe(25);
    expect(row["VENDOR BILL $ AMT"]).toBe(230);
    expect(row["CUSTOMER BILL"]).toBe("1042");
    expect(row["CUSTOMER BILL $ AMT"]).toBe(335);
    expect(row["PROFIT"]).toBe(80);
    expect(row["LAST UPDATED (PT)"]).toBe("2026-10-20 11:00");
    const tbd = toRow(order(1, { supplierCostTbd: true }));
    expect(tbd[HEADER.indexOf("VENDOR BILL $ AMT")]).toBe("TBD");
    expect(tbd[HEADER.indexOf("PROFIT")]).toBe("TBD");
    expect(toRow(order(1)).length).toBe(HEADER.length);
  });
});

describe("runBackup", () => {
  it("writes the header and one row per work order on the first run, growing the grid to the needed columns", async () => {
    const h = harness([order(100001), order(100000)]);
    const run = await h.run();
    expect(run).toMatchObject({ status: "ok", full: true, added: 2, updated: 0, rows: 2, headerWritten: true });
    expect(h.sheets.calls).toContain("addTab");
    expect(h.sheets.calls).toContain("grow 0 5");
    expect(h.sheets.grid[0]).toEqual([...HEADER]);
    expect(keys(h.sheets)).toEqual([100000, 100001]);
    expect(h.loads).toEqual([null]);
  });

  it("writes nothing on a rerun with no changes: no duplicates, no rewrites", async () => {
    const h = harness([order(100000), order(100001)]);
    await h.run();
    h.sheets.calls = [];
    h.advance(15 * 60_000);
    const run = await h.run(true);
    expect(run).toMatchObject({ status: "ok", added: 0, updated: 0, unchanged: 2, rows: 2, headerWritten: false });
    expect(h.sheets.calls.filter((c) => c.startsWith("write"))).toEqual([]);
    expect(keys(h.sheets)).toEqual([100000, 100001]);
  });

  it("rewrites a changed work order in place and adds new ones below, reading only changes since the watermark", async () => {
    const orders = [order(100000), order(100001)];
    const h = harness(orders);
    await h.run();
    const firstStart = h.runs[0].startedAt;
    h.advance(15 * 60_000);
    orders[0] = order(100000, { status: "completed", shopInvoiceRef: "INV-9", updatedAt: h.nowIso() });
    orders.push(order(100002, { updatedAt: h.nowIso() }));
    const run = await h.run();
    expect(run).toMatchObject({ full: false, added: 1, updated: 1, unchanged: 0, rows: 3 });
    expect(h.loads[1]).toBe(new Date(Date.parse(firstStart) - OVERLAP_MS).toISOString());
    expect(keys(h.sheets)).toEqual([100000, 100001, 100002]);
    expect(h.sheets.grid[1][HEADER.indexOf("STATUS")]).toBe("Completed");
    expect(h.sheets.grid[1][HEADER.indexOf("VENDOR BILL")]).toBe("INV-9");
    expect(h.sheets.calls.at(-1)).toBe("write A2:AE2,A4:AE4");
  });

  it("keeps the watermark of the last successful run when a run fails, and records the error", async () => {
    const h = harness([order(100000)]);
    await h.run();
    h.advance(15 * 60_000);
    h.sheets.read = async () => {
      throw new Error("Google Sheets read failed: HTTP 403");
    };
    const failed = await h.run();
    expect(failed).toMatchObject({ status: "error", error: "Google Sheets read failed: HTTP 403" });
    expect(runRow(failed)).toMatchObject({ system: "sheets", entity: "backup", status: "error", error: "Google Sheets read failed: HTTP 403" });
    h.advance(15 * 60_000);
    delete (h.sheets as Partial<FakeSheets>).read;
    await h.run();
    expect(h.loads[2]).toBe(new Date(Date.parse(h.runs[0].startedAt) - OVERLAP_MS).toISOString());
  });

  it("runs a full resync once the last full run is a day old, and on request", async () => {
    const h = harness([order(100000)]);
    await h.run();
    h.advance(FULL_EVERY_MS - 60_000);
    expect((await h.run()).full).toBe(false);
    h.advance(60_000);
    expect((await h.run()).full).toBe(true);
    h.advance(60_000);
    expect((await h.run(true)).full).toBe(true);
    expect(runRow(h.runs.at(-1)!).entity).toBe("backup_full");
  });

  it("full resync repairs a damaged header, a hand-edited row, and removes duplicate rows", async () => {
    const h = harness([order(100000), order(100001)]);
    await h.run();
    h.sheets.grid[0][2] = "something else";
    h.sheets.grid[2][HEADER.indexOf("UNIT #")] = "typed by hand";
    h.sheets.grid.push([...h.sheets.grid[1]]); // WO 100000 copied below
    h.advance(60_000);
    const run = await h.run(true);
    expect(run).toMatchObject({ headerWritten: true, duplicatesRemoved: 1, updated: 1, unchanged: 1, added: 0, rows: 2 });
    expect(h.sheets.grid[0]).toEqual([...HEADER]);
    expect(keys(h.sheets)).toEqual([100000, 100001]);
    expect(h.sheets.grid[2][HEADER.indexOf("UNIT #")]).toBe("U-100001");
  });

  it("grows the grid when new rows do not fit", async () => {
    const sheets = new FakeSheets();
    sheets.rowCount = 2;
    const h = harness([order(1), order(2), order(3)], sheets);
    await h.run();
    expect(sheets.calls).toContain("grow 2 5");
    expect(keys(sheets)).toEqual([1, 2, 3]);
  });

  it("keeps the row count in the run note for Admin > Settings", () => {
    const row = runRow({ full: false, status: "ok", startedAt: "2026-10-23T12:00:00.000Z", rows: 42, added: 1, updated: 2, unchanged: 3, duplicatesRemoved: 0, headerWritten: false, error: null });
    expect(row).toMatchObject({ system: "sheets", entity: "backup", direction: "push", status: "ok", external_id: "2026-10-23T12:00:00.000Z" });
    expect(rowsFromNote(row.error)).toBe(42);
  });
});

describe("sheetsConfig", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("is null (backup off) while the sheet id or the service account is missing", () => {
    expect(sheetsConfig({})).toBeNull();
    expect(sheetsConfig({ BACKUP_SHEET_ID: "abc" })).toBeNull();
    expect(sheetsConfig({ GOOGLE_SHEETS_SA_EMAIL: "a@b.iam.gserviceaccount.com", GOOGLE_SHEETS_SA_KEY: pem })).toBeNull();
    expect(sheetsConfig({ BACKUP_SHEET_ID: "abc", GOOGLE_SHEETS_SA_JSON: "{not json" })).toBeNull();
  });

  it("reads the JSON key file, or the email and key with escaped line breaks", () => {
    const json = JSON.stringify({ client_email: "backup@cds.iam.gserviceaccount.com", private_key: pem });
    expect(sheetsConfig({ BACKUP_SHEET_ID: "abc", GOOGLE_SHEETS_SA_JSON: json })).toEqual({
      email: "backup@cds.iam.gserviceaccount.com",
      privateKey: pem.trim(),
      sheetId: "abc",
    });
    const escaped = pem.replace(/\n/g, "\\n");
    expect(sheetsConfig({ BACKUP_SHEET_ID: "abc", GOOGLE_SHEETS_SA_EMAIL: "x@y", GOOGLE_SHEETS_SA_KEY: escaped })?.privateKey).toBe(pem.trim());
  });
});

describe("googleSheetsClient", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { email: "backup@cds.iam.gserviceaccount.com", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), sheetId: "SHEET" };

  it("signs an RS256 JWT for the spreadsheets scope", () => {
    const jwt = serviceAccountAssertion(config, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: config.email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("signs in once, creates the tab with a frozen header row, and writes RAW values", async () => {
    const seen: { url: string; method: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("oauth2")) return json({ access_token: "tok" });
      if (url.endsWith("?fields=sheets.properties")) return json({ sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] });
      if (url.endsWith(":batchUpdate"))
        return json({ replies: [{ addSheet: { properties: { sheetId: 9, title: TAB, gridProperties: { rowCount: 1000, columnCount: 26 } } } }] });
      return json({});
    }) as unknown as typeof fetch;
    const client = googleSheetsClient(config, fetchImpl);
    expect(await client.ensureTab(TAB)).toEqual({ sheetId: 9, rowCount: 1000, columnCount: 26 });
    await client.write([{ range: `'${TAB}'!A1:B1`, values: [["a", 1]] }]);
    expect(seen.filter((s) => s.url.includes("oauth2"))).toHaveLength(1);
    expect(new URLSearchParams(seen[0].body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(JSON.parse(seen[2].body).requests[0].addSheet.properties).toEqual({ title: TAB, gridProperties: { frozenRowCount: 1 } });
    expect(seen[3].url).toBe("https://sheets.googleapis.com/v4/spreadsheets/SHEET/values:batchUpdate");
    expect(JSON.parse(seen[3].body)).toEqual({ valueInputOption: "RAW", data: [{ range: `'${TAB}'!A1:B1`, values: [["a", 1]] }] });
  });

  it("explains a 403 (sheet not shared with the service account)", async () => {
    const fetchImpl = (async (url: string) =>
      url.includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "tok" }))
        : new Response(JSON.stringify({ error: { message: "The caller does not have permission" } }), { status: 403 })) as unknown as typeof fetch;
    await expect(googleSheetsClient(config, fetchImpl).read(`'${TAB}'!A1:AE`)).rejects.toThrow(/HTTP 403 The caller does not have permission.*shared with the service account/);
  });
});

describe("GET /api/cron/sheets-backup", () => {
  afterEach(() => vi.unstubAllEnvs());
  const SECRET = "s".repeat(40);
  const call = async (auth?: string) => {
    const { GET } = await import("@/app/api/cron/sheets-backup/route");
    return GET(new Request("http://localhost/api/cron/sheets-backup", { headers: auth ? { authorization: auth } : {} }));
  };

  it("answers 401 without the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
  });

  it("answers 503 and touches nothing (no database, no Google) when not configured", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("BACKUP_SHEET_ID", "");
    vi.stubEnv("GOOGLE_SHEETS_SA_JSON", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Google Sheets backup is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
