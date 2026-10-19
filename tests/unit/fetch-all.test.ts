import { describe, expect, it } from "vitest";
import { fetchAll, fetchAllSettled } from "@/lib/supabase/fetch-all";
import { loadPickerLocations } from "@/app/cds/work-orders/new/locations";

/** A table behind a fake PostgREST that, like the real one, returns at most 1000 rows per request. */
function cappedTable<T>(rows: T[], cap = 1000) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, from + cap);
    return Promise.resolve({ data: rows.slice(from, end), error: null });
  };
  return { page, calls };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe("fetchAll reads every row past the 1000 row cap", () => {
  it.each([0, 1, 999, 1000, 1001, 1237, 2000, 2500])("%i rows", async (n) => {
    const t = cappedTable(rows(n));
    const out = await fetchAll(t.page);
    expect(out).toHaveLength(n);
    expect(new Set(out.map((r) => r.id)).size).toBe(n);
    // One request per full page plus the short (or empty) last one.
    expect(t.calls).toHaveLength(Math.floor(n / 1000) + 1);
    expect(t.calls[0]).toEqual([0, 999]);
  });

  it("asks for consecutive ranges", async () => {
    const t = cappedTable(rows(2100));
    await fetchAll(t.page);
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("throws the API error", async () => {
    await expect(fetchAll(() => Promise.resolve({ data: null, error: { message: "boom" } }))).rejects.toThrow("boom");
  });

  it("stops at the row limit instead of looping forever", async () => {
    const endless = () => Promise.resolve({ data: rows(1000), error: null });
    await expect(fetchAll(endless, { maxRows: 5000 })).rejects.toThrow(/more than 5000 rows/);
  });

  it("settled form returns rows or the error instead of throwing", async () => {
    const ok = await fetchAllSettled(cappedTable(rows(1500)).page);
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(1500);
    const bad = await fetchAllSettled(() => Promise.resolve({ data: null, error: { message: "nope" } }));
    expect(bad).toEqual({ data: null, error: { message: "nope" } });
  });
});

/** Just enough of the Supabase query builder for loadPickerLocations, with the 1000 row cap. */
function fakeClient(locations: Record<string, unknown>[]) {
  const seen: { table?: string; filters: [string, unknown][]; orders: string[]; ranges: [number, number][] } = {
    filters: [],
    orders: [],
    ranges: [],
  };
  const builder = {
    select: () => builder,
    eq: (col: string, v: unknown) => {
      seen.filters.push([col, v]);
      return builder;
    },
    order: (col: string) => {
      seen.orders.push(col);
      return builder;
    },
    range: (from: number, to: number) => {
      seen.ranges.push([from, to]);
      const list = locations.filter((l) => l.active === true && l.market === "US");
      return Promise.resolve({ data: list.slice(from, Math.min(to + 1, from + 1000)), error: null });
    },
    then: (resolve: (v: unknown) => unknown) => {
      // Without a range PostgREST stops at 1000 rows.
      const list = locations.filter((l) => l.active === true && l.market === "US");
      return Promise.resolve({ data: list.slice(0, 1000), error: null }).then(resolve);
    },
  };
  const client = {
    from: (table: string) => {
      seen.table = table;
      return builder;
    },
  };
  return { client, seen };
}

describe("BUG-M2-10: Create Work Order loads every active location", () => {
  it("loads 1237 locations, not the first 1000", async () => {
    const locations = Array.from({ length: 1237 }, (_, i) => ({
      id: `loc-${String(i).padStart(5, "0")}`,
      customer_id: "ryder",
      code: String(i),
      location_number: String(i),
      name: `${i}-PLACE`,
      address_raw: "1 Main St",
      city: null,
      region: null,
      postal_code: null,
      fulfillment: "shipping",
      routing_notes: null,
      dock_note: null,
      active: true,
      market: "US",
      affiliates: i % 2 ? { display_name: "Akron" } : [{ display_name: "Atlanta" }],
    }));
    const { client, seen } = fakeClient(locations);
    const res = await loadPickerLocations(client as never);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1237);
    expect(res.data!.at(-1)!.name).toBe("1236-PLACE");
    expect(res.data![1].shopName).toBe("Akron");
    expect(res.data![0].shopName).toBe("Atlanta");
    expect(seen.table).toBe("customer_locations");
    expect(seen.filters).toEqual(
      expect.arrayContaining([
        ["active", true],
        ["market", "US"],
      ]),
    );
    // Ordered by a unique key last, so pages never overlap or skip rows.
    expect(seen.orders.at(-1)).toBe("id");
  });
});
