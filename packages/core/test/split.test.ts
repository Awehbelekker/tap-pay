import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cents } from "../src/money.js";
import {
  assertBalanced,
  computePostings,
  isCredit,
  partyKey,
  refundReversals,
  reversalKey,
  SplitError,
  sumBy,
  type Posting,
  type SplitInput,
} from "../src/split.js";

const base: SplitInput = {
  base: cents(50000),
  tip: cents(5000),
  providerFee: cents(0),
  servingStaffUserId: "coach",
  saleShares: [],
  tipRule: { kind: "direct" },
  poolMembers: null,
  feePolicy: "proportional",
  platformFee: { bp: 0, fixedCents: 0 },
};
const credits = (p: Posting[]) => Object.fromEntries(p.filter(isCredit).map((x) => [`${x.kind}|${partyKey(x.party)}`, x.amount]));

describe("computePostings examples (SPEC 8)", () => {
  it("spec example: R500 lesson + R50 tip, shop 30%, coach 70% plus the tip", () => {
    const p = computePostings({ ...base, saleShares: [{ to: "servingStaff", bp: 7000 }] });
    expect(credits(p)).toEqual({ "sale|staff:coach": 35000, "sale|merchant": 15000, "tip|staff:coach": 5000 });
  });

  it("no one serving: the staff share stays with the merchant and the tip waits in the pool", () => {
    const p = computePostings({ ...base, servingStaffUserId: null, saleShares: [{ to: "servingStaff", bp: 7000 }] });
    expect(credits(p)).toEqual({ "sale|merchant": 50000, "tip|pool": 5000 });
  });

  it("pool: split by weight across the shift, remainder cent to the merchant", () => {
    const p = computePostings({ ...base, tip: cents(1000), tipRule: { kind: "pool" }, poolMembers: [{ userId: "a", weight: 1 }, { userId: "b", weight: 1 }, { userId: "c", weight: 1 }] });
    expect(credits(p)).toMatchObject({ "tip|staff:a": 333, "tip|staff:b": 333, "tip|staff:c": 333, "tip|merchant": 1 });
  });

  it("house cut 20%, rest direct", () => {
    const p = computePostings({ ...base, tipRule: { kind: "house_cut", bp: 2000 } });
    expect(credits(p)).toMatchObject({ "tip|staff:coach": 4000, "tip|merchant": 1000 });
  });

  it("provider fee shared in proportion to each party's credit; staff see a net amount", () => {
    const p = computePostings({ ...base, providerFee: cents(1595), saleShares: [{ to: "servingStaff", bp: 7000 }] });
    const fees = Object.fromEntries(p.filter((x) => x.kind === "fee").map((x) => [partyKey(x.party), x.amount]));
    // coach credited 40000 of 55000 -> floor(1595 * 40000 / 55000) = 1160; merchant takes 435
    expect(fees).toEqual({ "staff:coach": -1160, merchant: -435 });
  });

  it("merchant can absorb the whole fee; platform fee is a merchant debit", () => {
    const p = computePostings({ ...base, providerFee: cents(1595), feePolicy: "merchant_absorbs", platformFee: { bp: 100, fixedCents: 50 } });
    expect(p.filter((x) => x.kind === "fee")).toEqual([{ kind: "fee", party: { kind: "merchant" }, amount: -1595 }]);
    expect(p.find((x) => x.kind === "platform_fee")).toEqual({ kind: "platform_fee", party: { kind: "merchant" }, amount: -600 });
  });

  it("refuses shares over 100% and fees over the payment", () => {
    expect(() => computePostings({ ...base, saleShares: [{ to: "servingStaff", bp: 7000 }, { to: "staff", userId: "x", bp: 4000 }] })).toThrow(SplitError);
    expect(() => computePostings({ ...base, providerFee: cents(60000) })).toThrow(SplitError);
  });
});

const arbInput: fc.Arbitrary<SplitInput> = fc.record({
  base: fc.integer({ min: 0, max: 50_000_000 }).map(cents),
  tip: fc.integer({ min: 0, max: 5_000_000 }).map(cents),
  providerFee: fc.constant(cents(0)),
  servingStaffUserId: fc.option(fc.constantFrom("s1", "s2"), { nil: null }),
  saleShares: fc.array(fc.oneof(fc.record({ to: fc.constant("servingStaff" as const), bp: fc.integer({ min: 0, max: 3000 }) }), fc.record({ to: fc.constant("staff" as const), userId: fc.constantFrom("s1", "s3"), bp: fc.integer({ min: 0, max: 3000 }) })), { maxLength: 3 }),
  tipRule: fc.oneof(fc.constant({ kind: "direct" as const }), fc.constant({ kind: "pool" as const }), fc.integer({ min: 0, max: 10000 }).map((bp) => ({ kind: "house_cut" as const, bp }))),
  poolMembers: fc.option(fc.uniqueArray(fc.record({ userId: fc.constantFrom("s1", "s2", "s3", "s4"), weight: fc.integer({ min: 1, max: 8 }) }), { selector: (m) => m.userId, maxLength: 4 }), { nil: null }),
  feePolicy: fc.constantFrom("proportional" as const, "merchant_absorbs" as const),
  platformFee: fc.record({ bp: fc.integer({ min: 0, max: 500 }), fixedCents: fc.integer({ min: 0, max: 500 }) }),
}).chain((i) => fc.integer({ min: 0, max: i.base + i.tip }).map((fee) => ({ ...i, providerFee: cents(fee) })));

describe("split properties (M5 acceptance)", () => {
  it("credits sum to the payment to the cent, fees to the provider fee, for any rules", () => {
    fc.assert(
      fc.property(arbInput, (i) => {
        const p = computePostings(i);
        assertBalanced(p, i.base + i.tip, i.providerFee);
        for (const x of p) expect(Number.isSafeInteger(x.amount)).toBe(true);
        // Nobody but the merchant is ever debited more fee than they were credited.
        for (const x of p.filter((y) => y.kind === "fee" && y.party.kind !== "merchant")) {
          const got = sumBy(p, (y) => isCredit(y) && partyKey(y.party) === partyKey(x.party));
          expect(-x.amount).toBeLessThanOrEqual(got);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("any sequence of partial refunds reverses exactly the refunded amount, and a full refund reverses every line", () => {
    fc.assert(
      fc.property(arbInput, fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 5 }), (i, parts) => {
        const original = computePostings(i);
        const gross = i.base + i.tip;
        if (gross === 0) return;
        const already = new Map<string, number>();
        let cumulative = 0;
        const steps = [...parts.map((x) => Math.min(x, gross)), gross]; // always finish with a full refund
        for (const step of steps) {
          cumulative = Math.min(gross, cumulative + step);
          for (const r of refundReversals(original, cumulative, already)) {
            const k = reversalKey(r.reverses!, r.party);
            already.set(k, (already.get(k) ?? 0) - r.amount);
          }
          const reversed = [...already.values()].reduce((a, b) => a + b, 0);
          expect(reversed).toBe(cumulative);
          for (const c of original.filter(isCredit)) {
            const rev = already.get(reversalKey(c.kind as "sale" | "tip", c.party)) ?? 0;
            expect(rev).toBeGreaterThanOrEqual(0);
            expect(rev).toBeLessThanOrEqual(c.amount);
          }
        }
        for (const c of original.filter(isCredit)) expect(already.get(reversalKey(c.kind as "sale" | "tip", c.party))).toBe(c.amount);
      }),
      { numRuns: 300 },
    );
  });

  it("100 random payments: lines sum to each payment (TEST_PLAN M5)", () => {
    const sample = fc.sample(arbInput, 100);
    for (const i of sample) expect(sumBy(computePostings(i), isCredit)).toBe(i.base + i.tip);
  });

  it("refuses refunds beyond the payment", () => {
    const original = computePostings(base);
    expect(() => refundReversals(original, 55001, new Map())).toThrow(SplitError);
  });
});
