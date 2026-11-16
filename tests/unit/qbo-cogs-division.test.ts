/**
 * The Division (QuickBooks Department) of a shop's bill (CDS, 2026-11-16): the customer's COGS
 * division, the counterpart of the INCOME division its invoices carry (RYDER INCOME on the
 * invoice, RYDER COGS on the bill). Picked from QuickBooks's Departments on the customer's
 * first bill and remembered; no match or two matches means no Division, never a guess.
 * Also the default bill terms: the QuickBooks Term named Net 30.
 */
import { describe, expect, it } from "vitest";
import { defaultBillTerm } from "@/lib/qbo/bill";
import { matchCogsDivision, type QboDepartment } from "@/lib/qbo/cogs-division";

const departments: QboDepartment[] = [
  { Id: "3", Name: "RYDER INCOME" },
  { Id: "4", Name: "RYDER COGS" },
  { Id: "5", Name: "First Student  Cogs" },
  { Id: "6", Name: "FIRST STUDENT INCOME" },
  { Id: "7", Name: "PEPSI COGS" },
  { Id: "8", Name: "Pepsi cogs" },
  { Id: "9", Name: "OLD COGS", Active: false },
  { Id: "10", Name: "Penske COGS" },
];

describe("matchCogsDivision", () => {
  it("replaces INCOME with COGS in the customer's income division", () => {
    expect(matchCogsDivision({ incomeDivision: "RYDER INCOME", customerName: "Ryder Truck Rental" }, departments)).toEqual({ id: "4", name: "RYDER COGS" });
  });

  it("ignores case and extra spaces", () => {
    expect(matchCogsDivision({ incomeDivision: "first student   income", customerName: "FS" }, departments)).toEqual({ id: "5", name: "First Student  Cogs" });
  });

  it("without an income division, accepts <customer> COGS", () => {
    expect(matchCogsDivision({ incomeDivision: null, customerName: "Penske" }, departments)).toEqual({ id: "10", name: "Penske COGS" });
    expect(matchCogsDivision({ incomeDivision: "SOMETHING ELSE", customerName: "ryder" }, departments)).toEqual({ id: "4", name: "RYDER COGS" });
  });

  it("is null when two divisions match (no guess)", () => {
    expect(matchCogsDivision({ incomeDivision: "PEPSI INCOME", customerName: "Pepsi" }, departments)).toBeNull();
  });

  it("is null when nothing matches, and ignores inactive divisions", () => {
    expect(matchCogsDivision({ incomeDivision: "ACME INCOME", customerName: "Acme" }, departments)).toBeNull();
    expect(matchCogsDivision({ incomeDivision: "OLD INCOME", customerName: "Old" }, departments)).toBeNull();
    expect(matchCogsDivision({ incomeDivision: null, customerName: "" }, departments)).toBeNull();
  });

  it("also matches the full name of a sub-division", () => {
    expect(matchCogsDivision({ incomeDivision: "TORQUE INCOME", customerName: "Torque" }, [{ Id: "20", Name: "TORQUE COGS", FullyQualifiedName: "COGS:TORQUE COGS" }])).toEqual({
      id: "20",
      name: "TORQUE COGS",
    });
  });
});

describe("defaultBillTerm", () => {
  it("is the active term named Net 30, ignoring case and spaces", () => {
    expect(defaultBillTerm([{ Id: "1", Name: "Due on receipt" }, { Id: "3", Name: "net  30" }])).toEqual({ value: "3", name: "net  30" });
  });

  it("is null when there is no Net 30 (the vendor's own terms apply) or two of them", () => {
    expect(defaultBillTerm([{ Id: "1", Name: "Net 15" }, { Id: "2", Name: "Net 30", Active: false }])).toBeNull();
    expect(defaultBillTerm([{ Id: "2", Name: "Net 30" }, { Id: "4", Name: "NET 30" }])).toBeNull();
  });
});
