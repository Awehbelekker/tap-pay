import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cents, formatRands, MoneyError, parsePercent, parseRands, percentTip, shareFloor, signedCents } from "../src/money.js";

describe("cents", () => {
  it("rejects floats, negatives and unsafe integers", () => {
    expect(() => cents(1.5)).toThrow(MoneyError);
    expect(() => cents(-1)).toThrow(MoneyError);
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
    expect(cents(0)).toBe(0);
  });
});

describe("parseRands", () => {
  it.each([
    ["25", 2500],
    ["25.5", 2550],
    ["25,50", 2550],
    ["R 1 234,50", 123450],
    ["r15", 1500],
    ["1,234.50", 123450],
    ["1.234,50", 123450],
    ["1,234", 123400],
    ["0.01", 1],
  ])("%s -> %d", (input, expected) => {
    expect(parseRands(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "12.345", "-5", "1e3", "R", "5..0"])("rejects %j", (input) => {
    expect(parseRands(input)).toBeNull();
  });

  it("round-trips any amount through formatRands", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_00 }), (n) => {
        expect(parseRands(formatRands(cents(n)))).toBe(n);
      }),
    );
  });
});

describe("formatRands", () => {
  it("uses space thousands and comma decimals", () => {
    expect(formatRands(cents(123450))).toBe("R1 234,50");
    expect(formatRands(cents(5))).toBe("R0,05");
    expect(formatRands(cents(50000))).toBe("R500,00");
    expect(formatRands(signedCents(-1180))).toBe("-R11,80");
  });
});

describe("shareFloor", () => {
  it("floors, so the remainder is left for the merchant", () => {
    expect(shareFloor(cents(50000), 7000)).toBe(35000);
    expect(shareFloor(cents(999), 3333)).toBe(332);
  });

  it("never exceeds the amount and never goes fractional", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), fc.integer({ min: 0, max: 10000 }), (a, bp) => {
        const s = shareFloor(cents(a), bp);
        expect(Number.isSafeInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(a);
      }),
    );
  });

  it("rejects out-of-range basis points", () => {
    expect(() => shareFloor(cents(100), 10001)).toThrow(MoneyError);
    expect(() => shareFloor(cents(100), 1.5)).toThrow(MoneyError);
  });
});

describe("percentTip", () => {
  it("rounds half up on the bill amount", () => {
    expect(percentTip(cents(50000), 1000)).toBe(5000);
    expect(percentTip(cents(1005), 1000)).toBe(101); // 100.5 -> 101
    expect(percentTip(cents(1004), 1000)).toBe(100); // 100.4 -> 100
  });

  it("is never negative or fractional", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_00 }), fc.integer({ min: 0, max: 10000 }), (a, bp) => {
        const t = percentTip(cents(a), bp);
        expect(Number.isSafeInteger(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe("parsePercent", () => {
  it.each([
    ["12%", 1200],
    ["12.5%", 1250],
    ["12,5 %", 1250],
    [" 7 % ", 700],
    ["0.25%", 25],
    ["100%", 10000],
  ])("%s -> %d bp", (input, bp) => {
    expect(parsePercent(input)).toBe(bp);
  });

  it.each(["12", "%", "12.345%", "-5%", "1000%", "abc%", "12%%"])("rejects %j", (input) => {
    expect(parsePercent(input)).toBeNull();
  });
});
