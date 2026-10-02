import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cents } from "../src/money.js";
import { postingsForPayment, sumCredits } from "../src/postings.js";
import { CLAIM_TOKEN_LENGTH, hashToken, newClaimToken, newUrlToken, parsePayCommand } from "../src/tokens.js";

describe("claim tokens", () => {
  it("are 6 characters from an unambiguous alphabet and parse back", () => {
    for (let i = 0; i < 200; i++) {
      const t = newClaimToken();
      expect(t).toHaveLength(CLAIM_TOKEN_LENGTH);
      expect(t).not.toMatch(/[ILO01]/);
      expect(parsePayCommand(`PAY ${t}`)).toBe(t);
    }
  });

  it("parses tolerant input and rejects anything else", () => {
    expect(parsePayCommand("  pay   abcdef ")).toBe("ABCDEF");
    for (const bad of ["PAY", "PAY ABCDE", "PAY ABCDEFG", "PAYABCDEF", "PAY ABC0EF", "hello PAY ABCDEF"]) {
      expect(parsePayCommand(bad)).toBeNull();
    }
  });

  it("hashes case-insensitively and depends on the pepper", () => {
    expect(hashToken("abcdef", "p").equals(hashToken("ABCDEF", "p"))).toBe(true);
    expect(hashToken("ABCDEF", "p").equals(hashToken("ABCDEF", "q"))).toBe(false);
  });

  it("makes long URL tokens", () => {
    expect(newUrlToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("postingsForPayment", () => {
  it("credits the sale to the merchant and the tip to the tied staff member", () => {
    const p = postingsForPayment({ base: cents(50000), tip: cents(5000), fee: cents(1595), tipStaffUserId: "u1" });
    expect(p).toEqual([
      { kind: "sale", partyKind: "merchant", partyUserId: null, amount: 50000 },
      { kind: "tip", partyKind: "staff", partyUserId: "u1", amount: 5000 },
      { kind: "fee", partyKind: "merchant", partyUserId: null, amount: -1595 },
    ]);
  });

  it("credits always sum to the gross payment, to the cent", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.option(fc.uuid(), { nil: null }),
        (base, tip, staff) => {
          const fee = Math.floor(((base + tip) * 290) / 10000);
          const p = postingsForPayment({ base: cents(base), tip: cents(tip), fee: cents(fee), tipStaffUserId: staff });
          expect(sumCredits(p)).toBe(base + tip);
          expect(p.filter((x) => x.kind === "fee").reduce((a, x) => a + x.amount, 0) + fee).toBe(0);
          for (const x of p) expect(Number.isSafeInteger(x.amount)).toBe(true);
        },
      ),
    );
  });

  it("refuses a fee larger than the payment", () => {
    expect(() => postingsForPayment({ base: cents(100), tip: cents(0), fee: cents(101), tipStaffUserId: null })).toThrow();
  });
});
