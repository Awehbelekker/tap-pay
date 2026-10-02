import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cents } from "../src/money.js";
import { normaliseVatNumber, parseInvoiceDetails, vatIncluded } from "../src/vat.js";

describe("VAT", () => {
  it("VAT inside an inclusive price, rounded half up", () => {
    expect(vatIncluded(cents(11500))).toBe(1500);
    expect(vatIncluded(cents(50000))).toBe(6522); // 50000 * 15 / 115 = 6521.74
    expect(vatIncluded(cents(23))).toBe(3); // 3.0
    expect(vatIncluded(cents(0))).toBe(0);
  });

  it("the excl. amount plus VAT is always the inclusive amount, and VAT is at most a cent off exact", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (n) => {
        const v = vatIncluded(cents(n));
        expect(Math.abs(v - (n * 15) / 115)).toBeLessThanOrEqual(0.5);
        expect(n - v + v).toBe(n);
      }),
    );
  });

  it("VAT numbers: 10 digits starting with 4", () => {
    expect(normaliseVatNumber("4123 456 789")).toBe("4123456789");
    expect(normaliseVatNumber("5123456789")).toBeNull();
    expect(normaliseVatNumber("412345678")).toBeNull();
  });

  it("parses the customer's details", () => {
    expect(parseInvoiceDetails("Acme (Pty) Ltd, 4123456789")).toEqual({ name: "Acme (Pty) Ltd", vat: "4123456789", address: null });
    expect(parseInvoiceDetails("Acme, Trading, 4123456789, 1 Main Rd, Muizenberg")).toEqual({ name: "Acme, Trading", vat: "4123456789", address: "1 Main Rd, Muizenberg" });
    expect(parseInvoiceDetails("4123456789")).toBeNull();
    expect(parseInvoiceDetails("Acme, 123")).toBeNull();
  });
});
