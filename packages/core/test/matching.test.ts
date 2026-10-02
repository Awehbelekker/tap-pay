import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideTap, equalShares, noBillAction, parseBillCode, type TapBill, type TapInput } from "../src/matching.js";
import { IllegalTransition, nextShare, SHARE_EVENTS, SHARE_STATES, type ShareEvent, type ShareState } from "../src/state.js";

const ME = "me";
const base: TapInput = { mode: "appointment", noBillActionOverride: null, customerId: ME, bills: [], codeLocked: false, recentlyPaidByMe: null };
const bill = (id: string, p: Partial<TapBill> = {}): TapBill => ({ id, status: "open", customerId: null, addressedToMe: null, hasShares: false, ...p });
const decide = (p: Partial<TapInput>) => decideTap({ ...base, ...p });

describe("decideTap (SPEC 5)", () => {
  it("quick tip mode never looks at bills", () => {
    expect(decide({ mode: "quick_tip", bills: [bill("a")] })).toEqual({ kind: "quick_tip" });
  });

  it("resumes the bill this customer already holds", () => {
    expect(decide({ bills: [bill("a"), bill("b", { status: "claimed", customerId: ME })] })).toEqual({ kind: "resume", billId: "b" });
  });

  it("number match beats the tag-claimable bill", () => {
    expect(decide({ bills: [bill("claimable"), bill("mine", { addressedToMe: true })] })).toEqual({ kind: "claim", billId: "mine" });
  });

  it("several bills addressed to me: choose", () => {
    expect(decide({ bills: [bill("a", { addressedToMe: true }), bill("b", { addressedToMe: true })] })).toEqual({ kind: "choose_bill", billIds: ["a", "b"] });
  });

  it("first tap claims the claimable bill", () => {
    expect(decide({ mode: "counter", bills: [bill("a")] })).toEqual({ kind: "claim", billId: "a" });
  });

  it("claimed by another phone: locked", () => {
    expect(decide({ bills: [bill("a", { status: "claimed", customerId: "other" })] })).toEqual({ kind: "locked" });
  });

  it("only bills addressed to other numbers: ask for the code, or refuse while locked out", () => {
    const bills = [bill("a", { addressedToMe: false })];
    expect(decide({ bills })).toEqual({ kind: "code_needed" });
    expect(decide({ bills, codeLocked: true })).toEqual({ kind: "code_locked" });
  });

  it("a claimable bill wins over bills addressed to others", () => {
    expect(decide({ bills: [bill("other", { addressedToMe: false }), bill("free")] })).toEqual({ kind: "claim", billId: "free" });
  });

  it("split bills go to share selection, even while other payers hold shares", () => {
    expect(decide({ mode: "table", bills: [bill("t", { hasShares: true })] })).toEqual({ kind: "choose_share", billId: "t" });
  });

  it("nothing open: slip again if I paid recently, else open amount or none", () => {
    expect(decide({ recentlyPaidByMe: "p" })).toEqual({ kind: "paid_already", ref: "p" });
    expect(decide({})).toEqual({ kind: "none" });
    expect(decide({ mode: "counter", noBillActionOverride: "ask_amount" })).toEqual({ kind: "ask_amount" });
  });

  it("always returns a decision and never claims a bill held by someone else", () => {
    const arbBill = fc.record({
      id: fc.constantFrom("a", "b", "c", "d"),
      status: fc.constantFrom("open" as const, "claimed" as const),
      customerId: fc.constantFrom(null, ME, "other"),
      addressedToMe: fc.constantFrom(null, true, false),
      hasShares: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.uniqueArray(arbBill, { maxLength: 4, selector: (b) => b.id }), fc.boolean(), (bills, codeLocked) => {
        const consistent = bills.map((b) => (b.status === "open" ? { ...b, customerId: null } : { ...b, customerId: b.customerId ?? "other" }));
        const d = decide({ bills: consistent, codeLocked });
        if (d.kind === "claim") {
          const target = consistent.find((b) => b.id === d.billId)!;
          expect(target.status).toBe("open");
          expect(target.addressedToMe).not.toBe(false);
        }
        if (d.kind === "resume") expect(consistent.find((b) => b.id === d.billId)!.customerId).toBe(ME);
      }),
    );
  });
});

describe("noBillAction", () => {
  it("is quick tip only in quick tip mode, else the merchant override", () => {
    expect(noBillAction("quick_tip", "none")).toBe("quick_tip");
    expect(noBillAction("counter", "ask_amount")).toBe("ask_amount");
    expect(noBillAction("field", null)).toBe("none");
  });
});

describe("bill codes and shares", () => {
  it("parses exactly 4 digits", () => {
    expect(parseBillCode(" 0427 ")).toBe("0427");
    for (const bad of ["427", "04271", "04a7", "PAY 0427"]) expect(parseBillCode(bad)).toBeNull();
  });

  it("equal shares always sum to the total and differ by at most a cent", () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 10_000_000 }), fc.integer({ min: 2, max: 10 }), (total, n) => {
        const s = equalShares(total, n);
        expect(s).toHaveLength(n);
        expect(s.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
      }),
    );
    expect(equalShares(30001, 3)).toEqual([10001, 10000, 10000]);
    expect(() => equalShares(100, 1)).toThrow();
  });

  const SHARE_EXPECT: Record<ShareState, Partial<Record<ShareEvent, ShareState>>> = {
    open: { claim: "claimed", pay: "paid", cancel: "cancelled" },
    claimed: { release: "open", pay: "paid", cancel: "cancelled" },
    paid: {},
    cancelled: {},
  };
  for (const s of SHARE_STATES) {
    for (const e of SHARE_EVENTS) {
      const want = SHARE_EXPECT[s][e];
      it(`share ${s} --${e}--> ${want ?? "illegal"}`, () => {
        if (want) expect(nextShare(s, e)).toBe(want);
        else expect(() => nextShare(s, e)).toThrow(IllegalTransition);
      });
    }
  }
});
