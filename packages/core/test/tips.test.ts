import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cents } from "../src/money.js";
import { DEFAULT_TIP_POLICY, offeredPresets, parseTipText, resolveTip, tipCap, type TipPolicy } from "../src/tips.js";

const P = DEFAULT_TIP_POLICY;
const policy = fc.record({
  presetsPercent: fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { maxLength: 4 }),
  minCents: fc.integer({ min: 1, max: 1000 }),
  maxBp: fc.integer({ min: 1, max: 10000 }),
  maxCents: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
}) as fc.Arbitrary<TipPolicy>;
const bill = fc.integer({ min: 1, max: 100_000_000 });

describe("resolveTip examples (SPEC 7)", () => {
  it("presets are percent of the bill, rounded half up", () => {
    expect(resolveTip(cents(50000), { kind: "preset", percent: 15 }, P)).toEqual({ ok: true, tip: 7500 });
    expect(resolveTip(cents(33300), { kind: "preset", percent: 15 }, P)).toEqual({ ok: true, tip: 4995 });
    expect(resolveTip(cents(1005), { kind: "preset", percent: 10 }, P)).toEqual({ ok: true, tip: 101 });
  });

  it("no tip is always allowed", () => {
    expect(resolveTip(cents(0), { kind: "none" }, P)).toEqual({ ok: true, tip: 0 });
  });

  it("custom amounts and percentages respect min and cap", () => {
    expect(resolveTip(cents(10000), { kind: "amount", cents: 99 }, P)).toEqual({ ok: false, reason: "below_min" });
    expect(resolveTip(cents(10000), { kind: "amount", cents: 10001 }, P)).toEqual({ ok: false, reason: "above_max" });
    expect(resolveTip(cents(10000), { kind: "percent", bp: 1250 }, P)).toEqual({ ok: true, tip: 1250 });
    expect(resolveTip(cents(10000), { kind: "percent", bp: 10100 }, P)).toEqual({ ok: false, reason: "above_max" });
  });

  it("a merchant cap of 15% and R50 hides higher presets and refuses bigger custom tips", () => {
    const capped: TipPolicy = { ...P, maxBp: 1500, maxCents: 5000 };
    expect(tipCap(cents(50000), capped)).toBe(5000);
    expect(offeredPresets(cents(50000), capped)).toEqual([10]); // 15% = R75 > R50
    expect(offeredPresets(cents(20000), capped)).toEqual([10, 15]);
    expect(resolveTip(cents(50000), { kind: "preset", percent: 20 }, capped)).toEqual({ ok: false, reason: "not_offered" });
    expect(resolveTip(cents(50000), { kind: "amount", cents: 5000 }, capped)).toEqual({ ok: true, tip: 5000 });
    expect(resolveTip(cents(50000), { kind: "amount", cents: 5001 }, capped)).toEqual({ ok: false, reason: "above_max" });
  });

  it("presets that round to zero are not offered", () => {
    expect(offeredPresets(cents(2), P)).toEqual([]); // 10, 15, 20% of 2c all round to 0
    expect(offeredPresets(cents(4), P)).toEqual([15, 20]); // 0.6c and 0.8c round up to 1c
  });

  it("parses typed tips", () => {
    expect(parseTipText("12%")).toEqual({ kind: "percent", bp: 1200 });
    expect(parseTipText("R 25,50")).toEqual({ kind: "amount", cents: 2550 });
    expect(parseTipText("lots")).toBeNull();
  });
});

describe("tip maths properties", () => {
  it("a preset tip is within half a cent of the exact percentage", () => {
    fc.assert(
      fc.property(bill, fc.integer({ min: 1, max: 100 }), (b, pc) => {
        const r = resolveTip(cents(b), { kind: "preset", percent: pc }, { ...P, presetsPercent: [pc] });
        if (!r.ok) return; // rounded to 0 or above the default 100% cap: not offered
        const exactTimes10000 = BigInt(b) * BigInt(pc * 100);
        const diff = BigInt(r.tip) * 10000n - exactTimes10000;
        expect(diff >= -5000n && diff <= 5000n).toBe(true);
      }),
    );
  });

  it("an accepted tip is a non-negative integer, within the cap, and at least the minimum unless zero", () => {
    const choice = fc.oneof(
      fc.constant({ kind: "none" as const }),
      fc.integer({ min: 1, max: 100 }).map((percent) => ({ kind: "preset" as const, percent })),
      fc.integer({ min: 0, max: 10_000_000 }).map((c) => ({ kind: "amount" as const, cents: c })),
      fc.integer({ min: 0, max: 20000 }).map((bp) => ({ kind: "percent" as const, bp })),
    );
    fc.assert(
      fc.property(bill, choice, policy, (b, c, p) => {
        const r = resolveTip(cents(b), c, p);
        if (!r.ok) return;
        expect(Number.isSafeInteger(r.tip)).toBe(true);
        expect(r.tip).toBeGreaterThanOrEqual(0);
        if (c.kind !== "none") expect(r.tip).toBeLessThanOrEqual(tipCap(cents(b), p));
        if (c.kind === "amount" || c.kind === "percent") expect(r.tip).toBeGreaterThanOrEqual(p.minCents);
        expect(Number.isSafeInteger(b + r.tip)).toBe(true);
      }),
    );
  });

  it("higher presets never give a smaller tip", () => {
    fc.assert(
      fc.property(bill, fc.integer({ min: 1, max: 99 }), (b, pc) => {
        const all: TipPolicy = { ...P, presetsPercent: [pc, pc + 1] };
        const lo = resolveTip(cents(b), { kind: "preset", percent: pc }, all);
        const hi = resolveTip(cents(b), { kind: "preset", percent: pc + 1 }, all);
        if (lo.ok && hi.ok) expect(hi.tip).toBeGreaterThanOrEqual(lo.tip);
      }),
    );
  });

  it("every offered preset resolves, and nothing else does", () => {
    fc.assert(
      fc.property(bill, policy, fc.integer({ min: 1, max: 100 }), (b, p, pc) => {
        const offered = offeredPresets(cents(b), p);
        expect(resolveTip(cents(b), { kind: "preset", percent: pc }, p).ok).toBe(offered.includes(pc));
      }),
    );
  });
});
