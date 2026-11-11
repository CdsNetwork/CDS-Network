import { describe, expect, it } from "vitest";
import { pricedLineInput, shopRateInput } from "@/lib/pass-through";
import { hasMissingShopRate, shopMoney, shopPayable } from "@/lib/shop-deductions";

describe("shop rate entered on a line (TBD until then)", () => {
  it("accepts dollars and cents, including zero", () => {
    expect(shopRateInput("25.5")).toEqual({ ok: true, amount: 25.5 });
    expect(shopRateInput(" $1,250.00 ")).toEqual({ ok: true, amount: 1250 });
    expect(shopRateInput("0")).toEqual({ ok: true, amount: 0 });
  });

  it("refuses anything else", () => {
    for (const bad of ["", "abc", "-1", "1.234", "100000"]) expect(shopRateInput(bad).ok, bad).toBe(false);
  });
});

describe("items priced on the order", () => {
  it("takes the customer price, an optional description and an optional shop rate", () => {
    expect(pricedLineInput("  ", "625", "")).toEqual({ ok: true, description: "", amount: 625, shopRate: null });
    expect(pricedLineInput(" DPF 2871 ", "$625.00", "450")).toEqual({ ok: true, description: "DPF 2871", amount: 625, shopRate: 450 });
  });

  it("needs a customer price above zero and a valid shop rate when one is typed", () => {
    expect(pricedLineInput("", "", "")).toMatchObject({ ok: false, error: expect.stringMatching(/customer price/) });
    expect(pricedLineInput("", "0", "")).toMatchObject({ ok: false });
    expect(pricedLineInput("", "625", "abc")).toMatchObject({ ok: false, error: expect.stringMatching(/shop rate/) });
    expect(pricedLineInput("x".repeat(501), "625", "")).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
  });
});

describe("the shop's bill with a rate TBD", () => {
  const lines = [
    { qty: 2, shop_unit_rate: 10 },
    { qty: 1, shop_unit_rate: null },
  ];

  it("is TBD, not the other lines' sum", () => {
    expect(hasMissingShopRate(lines)).toBe(true);
    expect(hasMissingShopRate([lines[0]])).toBe(false);
    expect(shopMoney(null)).toBe("TBD");
    expect(shopMoney(shopPayable([lines[0]], []))).toBe("$20.00");
  });
});
