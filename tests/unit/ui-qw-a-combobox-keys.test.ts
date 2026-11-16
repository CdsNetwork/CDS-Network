/**
 * Enter in a search box (location picker, catalog search) picks from the list and never
 * submits the outer form.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comboboxKey } from "@/lib/combobox-keys";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const state = (s: Partial<Parameters<typeof comboboxKey>[1]> = {}) => ({ open: true, active: 0, count: 3, picked: false, typed: true, ...s });

describe("comboboxKey", () => {
  it("arrows move the active option within the list and open it", () => {
    expect(comboboxKey("ArrowDown", state({ active: 0 }))).toEqual({ type: "move", active: 1 });
    expect(comboboxKey("ArrowDown", state({ active: 2 }))).toEqual({ type: "move", active: 2 });
    expect(comboboxKey("ArrowUp", state({ active: 1 }))).toEqual({ type: "move", active: 0 });
    expect(comboboxKey("ArrowUp", state({ active: 0 }))).toEqual({ type: "move", active: 0 });
    expect(comboboxKey("ArrowDown", state({ count: 0 }))).toEqual({ type: "move", active: 0 });
  });

  it("Enter picks the active option while the list is open", () => {
    expect(comboboxKey("Enter", state({ active: 1 }))).toEqual({ type: "pick", index: 1 });
  });

  it("Enter picks the only option when none is active", () => {
    expect(comboboxKey("Enter", state({ active: -1, count: 1 }))).toEqual({ type: "pick", index: 0 });
  });

  it("Enter with nothing to pick is blocked, never a form submit", () => {
    expect(comboboxKey("Enter", state({ count: 0 }))).toEqual({ type: "block" });
    expect(comboboxKey("Enter", state({ active: -1, count: 4 }))).toEqual({ type: "block" });
    expect(comboboxKey("Enter", state({ open: false, picked: false }))).toEqual({ type: "block" });
  });

  it("Enter on an already picked value asks for the add, not a form submit", () => {
    expect(comboboxKey("Enter", state({ open: false, picked: true }))).toEqual({ type: "enter-picked" });
    // Focus opens the list with nothing typed: Enter keeps the pick instead of taking the first row.
    expect(comboboxKey("Enter", state({ open: true, picked: true, typed: false }))).toEqual({ type: "enter-picked" });
  });

  it("Escape closes, other keys do nothing", () => {
    expect(comboboxKey("Escape", state())).toEqual({ type: "close" });
    expect(comboboxKey("a", state())).toEqual({ type: "none" });
  });
});

describe("pickers use it", () => {
  it("LocationPicker handles keys and points at the active option", () => {
    const picker = source("components/cds-wo/LocationPicker.tsx");
    expect(picker).toMatch(/comboboxKey\(/);
    expect(picker).toMatch(/onKeyDown=/);
    expect(picker).toMatch(/aria-activedescendant=/);
    expect(picker).toMatch(/onClick=/);
  });

  it("SearchSelect handles keys through it and options are clickable by keyboard", () => {
    const select = source("components/SearchSelect.tsx");
    expect(select).toMatch(/comboboxKey\(/);
    expect(select).toMatch(/onEnterPicked/);
    expect(select).toMatch(/aria-activedescendant=/);
    expect(select).toMatch(/onClick=/);
  });

  it("without onEnterPicked, Enter on a picked value still submits its own small form (+ Add Item)", () => {
    const select = source("components/SearchSelect.tsx");
    expect(select).toMatch(/if \(onEnterPicked\) \{\s*e\.preventDefault\(\);\s*onEnterPicked\(\);/);
  });

  it("the create form adds the picked catalog item on Enter", () => {
    const form = source("components/cds-wo/NewWorkOrderForm.tsx");
    expect(form).toMatch(/onEnterPicked=\{addLine\}/);
  });
});
