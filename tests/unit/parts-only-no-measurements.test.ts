/**
 * Sarah, CDS, 2026-11-18: "Filter sales do not need measurement info". A work order with
 * request type Parts Only completes without components or measurements at every shop, not
 * only at CDS's in-house shop (20261110040000_in_house_parts_sale.sql). The database rule is
 * in tests/rls/in-house-shop.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPartsSale } from "@/components/shop/types";

const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");
const migrations = join(__dirname, "../../supabase/migrations");
const migration = (name: string) => readFileSync(join(migrations, name), "utf8");

/** The shop_complete_work_order definition in a migration, with comments and spacing removed. */
function completeFunction(sql: string): string {
  const start = sql.indexOf("create or replace function public.shop_complete_work_order");
  const end = sql.indexOf("end $$;", start);
  expect(start, "shop_complete_work_order is defined").toBeGreaterThanOrEqual(0);
  return sql
    .slice(start, end)
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .join("\n");
}

describe("isPartsSale", () => {
  it("is true for a parts-only order and false for a service order", () => {
    expect(isPartsSale("parts_only")).toBe(true);
    expect(isPartsSale("service")).toBe(false);
  });
});

describe("shop job page", () => {
  it("treats every parts-only order as a parts sale, not only in-house ones", () => {
    const data = src("app/shop/data.ts");
    expect(data).toMatch(/partsSale: isPartsSale\(w\.request_type\)/);
    expect(data).not.toMatch(/inHouse && w\.request_type === "parts_only"/);
  });

  it("does not ask for components on a parts sale", () => {
    const detail = src("components/shop/JobDetail.tsx");
    // The add form is not shown, and the help text says no components are needed.
    expect(detail).toMatch(/editable && !data\.partsSale && \(/);
    expect(detail).toMatch(/Parts-only order: no components or measurements are needed\./);
    // The completion text of an outside shop says so too.
    expect(detail).toMatch(/Parts-only order: no components are needed\. Enter your invoice or reference number to complete\./);
  });
});

describe("database: shop_complete_work_order", () => {
  const files = readdirSync(migrations).sort();
  const latest = files.filter((f) => /create or replace function public\.shop_complete_work_order/.test(migration(f))).at(-1)!;

  it("the latest definition skips the component checks for every parts-only order", () => {
    expect(latest).toBe("20261119090000_parts_only_no_measurements.sql");
    const body = completeFunction(migration(latest));
    expect(body).toMatch(/parts_sale := wo\.request_type = 'parts_only';/);
    expect(body).not.toMatch(/parts_sale := .*is_in_house_shop/);
  });

  it("is otherwise the same as 20261119040000_egr_no_photo_doc_optional.sql", () => {
    const before = completeFunction(migration("20261119040000_egr_no_photo_doc_optional.sql")).split("\n");
    const after = completeFunction(migration(latest)).split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed).toEqual(["parts_sale := wo.request_type = 'parts_only';"]);
  });

  it("keeps the grants", () => {
    const sql = migration(latest);
    expect(sql).toMatch(/grant execute on function public\.shop_complete_work_order\(uuid, text\) to authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.shop_complete_work_order\(uuid, text\) to service_role;/);
  });
});
