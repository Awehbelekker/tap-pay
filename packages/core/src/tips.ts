import { cents, parsePercent, parseRands, percentTip, type Cents } from "./money.js";

/**
 * Tip rules (SPEC 7) as pure functions. The flow parses what the customer chose, calls
 * `resolveTip`, and only ever stores the integer cents this returns.
 *
 * - Presets are whole percents of the bill amount (not of any earlier tip), rounded half up.
 * - A custom tip is typed in rand ("25", "12,50") or as a percentage ("12%").
 * - The cap is the lower of `maxBp` of the bill and `maxCents` (if set). A non-zero custom tip
 *   must be at least `minCents`. Presets whose tip would exceed the cap or round to 0 are not
 *   offered.
 */

export interface TipPolicy {
  /** Whole percents, at most 4 (SPEC 7). */
  presetsPercent: number[];
  /** Smallest non-zero custom tip. Default R1,00. */
  minCents: number;
  /** Largest tip as basis points of the bill. Default 10000 (100%). */
  maxBp: number;
  /** Optional absolute cap. */
  maxCents: number | null;
}

export const DEFAULT_TIP_POLICY: TipPolicy = { presetsPercent: [10, 15, 20], minCents: 100, maxBp: 10000, maxCents: null };

export type TipChoice =
  | { kind: "none" }
  | { kind: "preset"; percent: number }
  | { kind: "amount"; cents: number }
  | { kind: "percent"; bp: number };

export type TipResult = { ok: true; tip: Cents } | { ok: false; reason: "not_offered" | "below_min" | "above_max" | "no_bill" };

/** Largest allowed tip on this bill. */
export function tipCap(base: Cents, p: TipPolicy): Cents {
  const byPercent = Number((BigInt(base) * BigInt(p.maxBp)) / 10000n);
  return cents(p.maxCents === null ? byPercent : Math.min(byPercent, p.maxCents));
}

/** The presets worth showing for this bill: non-zero and within the cap. */
export function offeredPresets(base: Cents, p: TipPolicy): number[] {
  const cap = tipCap(base, p);
  return p.presetsPercent.slice(0, 4).filter((pc) => {
    const t = percentTip(base, pc * 100);
    return t > 0 && t <= cap;
  });
}

export function resolveTip(base: Cents, choice: TipChoice, p: TipPolicy): TipResult {
  if (choice.kind === "none") return { ok: true, tip: cents(0) };
  if (base <= 0) return { ok: false, reason: "no_bill" };
  const cap = tipCap(base, p);
  if (choice.kind === "preset") {
    // Only what is on offer: a forged reply cannot pick another percentage.
    if (!offeredPresets(base, p).includes(choice.percent)) return { ok: false, reason: "not_offered" };
    return { ok: true, tip: percentTip(base, choice.percent * 100) };
  }
  const tip = choice.kind === "amount" ? choice.cents : choice.bp > 10000 ? Infinity : percentTip(base, choice.bp);
  if (!Number.isFinite(tip) || tip > cap) return { ok: false, reason: "above_max" };
  if (tip < p.minCents) return { ok: false, reason: "below_min" };
  return { ok: true, tip: cents(tip) };
}

/** What the customer typed after "Other amount": a percentage if it has %, else rand. */
export function parseTipText(text: string): TipChoice | null {
  const bp = parsePercent(text);
  if (bp !== null) return { kind: "percent", bp };
  const c = parseRands(text);
  return c === null ? null : { kind: "amount", cents: c };
}
