import { describe, expect, it } from "vitest";
import { clampPage } from "@/components/cds-admin/Pager";

describe("BUG-18: a page number past the end shows the last page", () => {
  it.each([
    [99, 679, 50, 14],
    [14, 679, 50, 14],
    [1, 679, 50, 1],
    [0, 679, 50, 1],
    [5, 0, 50, 1],
    [3, 100, 50, 2],
  ])("page %i of %i rows (%i per page) -> %i", (page, total, size, expected) => {
    expect(clampPage(page, total, size)).toBe(expected);
  });
});
