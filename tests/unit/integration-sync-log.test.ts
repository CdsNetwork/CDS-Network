/**
 * QA observation (m2-r1/billing): integration_sync inserts were not error checked, so a failed
 * audit row vanished without a trace. recordSync logs the failure and never blocks the user flow.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordSync } from "@/lib/integration-sync";

const row = { system: "shipstation", entity: "rates", entity_id: "s1", direction: "push", status: "error", error: "boom" };

function fakeDb(result: { error: { message: string } | null } | Error) {
  const insert = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { db: { from: vi.fn(() => ({ insert })) }, insert };
}

afterEach(() => vi.restoreAllMocks());

describe("recordSync", () => {
  it("inserts the row and reports success", async () => {
    const { db, insert } = fakeDb({ error: null });
    expect(await recordSync(db as never, row)).toBe(true);
    expect(db.from).toHaveBeenCalledWith("integration_sync");
    expect(insert).toHaveBeenCalledWith(row);
  });

  it("logs a refused insert and does not throw", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ error: { message: "permission denied for table integration_sync" } });
    expect(await recordSync(db as never, row)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/integration_sync.*shipstation\/rates.*permission denied/);
  });

  it("logs a network failure and does not throw", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(new Error("fetch failed"));
    expect(await recordSync(db as never, row)).toBe(false);
    expect(String(log.mock.calls[0][0])).toMatch(/fetch failed/);
  });
});

describe("integration_sync inserts in the app", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });

  it("never ignore the insert result", () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const unchecked = files(src).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((line) => /^\s*await \w+\.from\("integration_sync"\)\.insert\(/.test(line))
        .map((line) => `${path.relative(src, f)}: ${line.trim()}`),
    );
    expect(unchecked).toEqual([]);
  });
});

