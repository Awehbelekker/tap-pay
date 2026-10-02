import type { Cents } from "./money.js";

/**
 * Who gets what from one payment (SPEC 8). Pure functions over integer cents.
 *
 * Rounding rule (SPEC 8.2): every non-merchant share is floored; the merchant takes the
 * remainder, so credit lines always sum to the gross exactly. Provider and platform fees are
 * separate debit lines.
 *
 * Invariants (property-tested):
 *   sum(credits) == base + tip
 *   sum(provider fee debits) == -providerFee
 *   refunds reverse credits proportionally, and a full refund reverses every line exactly
 */

export type Party = { kind: "merchant" } | { kind: "staff"; userId: string } | { kind: "pool" };

export type PostingKind = "sale" | "tip" | "fee" | "platform_fee" | "refund";

export interface Posting {
  kind: PostingKind;
  party: Party;
  /** Signed cents: credits positive, debits negative. */
  amount: number;
  /** For refund lines: which credit line they reverse. */
  reverses?: "sale" | "tip";
}

/** A share of the sale for someone other than the merchant. `servingStaff` = whoever served. */
export type SaleShare = { to: "servingStaff"; bp: number } | { to: "staff"; userId: string; bp: number };

export type TipRule = { kind: "direct" } | { kind: "pool" } | { kind: "house_cut"; bp: number };

export interface SplitInput {
  base: Cents;
  tip: Cents;
  providerFee: Cents;
  servingStaffUserId: string | null;
  /** Non-merchant sale shares (basis points of the sale); the merchant keeps the rest. */
  saleShares: SaleShare[];
  tipRule: TipRule;
  /** Members of the current tip-pool shift, or null if no pool shift is running. */
  poolMembers: { userId: string; weight: number }[] | null;
  feePolicy: "proportional" | "merchant_absorbs";
  platformFee: { bp: number; fixedCents: number };
}

export const partyKey = (p: Party): string => (p.kind === "staff" ? `staff:${p.userId}` : p.kind);

const floorBp = (amount: number, bp: number) => Number((BigInt(amount) * BigInt(bp)) / 10000n);

/** Split `amount` across weighted members: floors, with the remainder returned separately. */
function byWeight(amount: number, members: { userId: string; weight: number }[]): { shares: { userId: string; amount: number }[]; remainder: number } {
  const total = members.reduce((a, m) => a + m.weight, 0);
  if (total <= 0) return { shares: [], remainder: amount };
  const shares = members.map((m) => ({ userId: m.userId, amount: Number((BigInt(amount) * BigInt(m.weight)) / BigInt(total)) }));
  return { shares, remainder: amount - shares.reduce((a, s) => a + s.amount, 0) };
}

class Lines {
  private readonly map = new Map<string, Posting>();
  add(kind: PostingKind, party: Party, amount: number): void {
    if (amount === 0) return;
    const k = `${kind}|${partyKey(party)}`;
    const cur = this.map.get(k);
    if (cur) cur.amount += amount;
    else this.map.set(k, { kind, party, amount });
  }
  all(): Posting[] {
    return [...this.map.values()].filter((p) => p.amount !== 0);
  }
}

export class SplitError extends Error {}

export function validateSaleShares(shares: SaleShare[]): void {
  for (const s of shares) if (!Number.isInteger(s.bp) || s.bp < 0 || s.bp > 10000) throw new SplitError(`share out of range: ${s.bp}`);
  if (shares.reduce((a, s) => a + s.bp, 0) > 10000) throw new SplitError("sale shares exceed 100%");
}

export function computePostings(i: SplitInput): Posting[] {
  const gross = i.base + i.tip;
  if (i.providerFee > gross) throw new SplitError("provider fee exceeds payment");
  validateSaleShares(i.saleShares);
  const lines = new Lines();
  const merchant: Party = { kind: "merchant" };

  // Sale: floored shares to staff; the merchant keeps the remainder. A "serving staff" share with
  // nobody serving stays with the merchant.
  let saleLeft: number = i.base;
  for (const s of i.saleShares) {
    const userId = s.to === "servingStaff" ? i.servingStaffUserId : s.userId;
    if (!userId) continue;
    const amt = floorBp(i.base, s.bp);
    lines.add("sale", { kind: "staff", userId }, amt);
    saleLeft -= amt;
  }
  lines.add("sale", merchant, saleLeft);

  // Tip: direct to the serving staff member; otherwise (or by rule) to the shift's pool.
  let tipLeft: number = i.tip;
  const staffPart = i.tipRule.kind === "house_cut" ? floorBp(i.tip, 10000 - i.tipRule.bp) : i.tip;
  const toPool = i.tipRule.kind === "pool" || !i.servingStaffUserId;
  if (staffPart > 0) {
    if (!toPool) {
      lines.add("tip", { kind: "staff", userId: i.servingStaffUserId! }, staffPart);
      tipLeft -= staffPart;
    } else if (i.poolMembers && i.poolMembers.length > 0) {
      const { shares } = byWeight(staffPart, i.poolMembers);
      for (const s of shares) {
        lines.add("tip", { kind: "staff", userId: s.userId }, s.amount);
        tipLeft -= s.amount;
      }
    } else {
      // No shift running: the tips wait in the merchant's undistributed pool (SPEC 8.1).
      lines.add("tip", { kind: "pool" }, staffPart);
      tipLeft -= staffPart;
    }
  }
  lines.add("tip", merchant, tipLeft); // house cut and rounding remainder

  const credits = lines.all();

  // Provider fee: proportional to each party's gross credit, floored; the merchant takes the rest.
  if (i.providerFee > 0) {
    if (i.feePolicy === "merchant_absorbs" || gross === 0) {
      lines.add("fee", merchant, -i.providerFee);
    } else {
      const perParty = new Map<string, { party: Party; amount: number }>();
      for (const c of credits) {
        const k = partyKey(c.party);
        const cur = perParty.get(k) ?? { party: c.party, amount: 0 };
        cur.amount += c.amount;
        perParty.set(k, cur);
      }
      let feeLeft: number = i.providerFee;
      for (const { party, amount } of perParty.values()) {
        if (party.kind === "merchant") continue;
        const f = Number((BigInt(i.providerFee) * BigInt(amount)) / BigInt(gross));
        lines.add("fee", party, -f);
        feeLeft -= f;
      }
      lines.add("fee", merchant, -feeLeft);
    }
  }

  // Platform fee (default 0 until the business model is decided; OPEN_QUESTIONS Q2).
  const platform = Math.min(gross, floorBp(gross, i.platformFee.bp) + i.platformFee.fixedCents);
  if (platform > 0) lines.add("platform_fee", merchant, -platform);

  return lines.all();
}

export function sumBy(p: Posting[], pred: (x: Posting) => boolean): number {
  return p.filter(pred).reduce((a, x) => a + x.amount, 0);
}

export const isCredit = (p: Posting) => (p.kind === "sale" || p.kind === "tip") && p.amount > 0;

/**
 * Refund reversals (SPEC 10). Given the payment's original credit lines and the cumulative
 * refunded amount (this refund included), return the reversal lines still to post, so that
 * after every refund: total reversed == cumulative refund, each line's reversal is
 * proportional (floored, merchant takes the remainder), and a full refund reverses every
 * credit exactly. `already` is what earlier refunds reversed, by line key.
 */
export function refundReversals(
  original: Posting[],
  cumulativeRefund: number,
  already: Map<string, number>,
): Posting[] {
  const creditLines = original.filter(isCredit);
  const gross = creditLines.reduce((a, c) => a + c.amount, 0);
  if (!Number.isSafeInteger(cumulativeRefund) || cumulativeRefund < 0 || cumulativeRefund > gross) {
    throw new SplitError("refund outside 0..payment amount");
  }
  const key = (c: Posting) => `${c.kind}|${partyKey(c.party)}`;
  const targets = creditLines.map((c) => ({ c, target: gross === 0 ? 0 : Number((BigInt(c.amount) * BigInt(cumulativeRefund)) / BigInt(gross)) }));
  let remainder = cumulativeRefund - targets.reduce((a, t) => a + t.target, 0);
  // Rounding cents go to merchant lines first, then to any line with room left.
  const order = [...targets.filter((t) => t.c.party.kind === "merchant"), ...targets.filter((t) => t.c.party.kind !== "merchant")];
  for (const t of order) {
    if (remainder === 0) break;
    const room = t.c.amount - t.target;
    const take = Math.min(room, remainder);
    t.target += take;
    remainder -= take;
  }
  const out: Posting[] = [];
  for (const t of targets) {
    const delta = t.target - (already.get(key(t.c)) ?? 0);
    if (delta !== 0) out.push({ kind: "refund", party: t.c.party, amount: -delta, reverses: t.c.kind as "sale" | "tip" });
  }
  return out;
}

/** Line key used by refundReversals' `already` map. */
export const reversalKey = (reverses: "sale" | "tip", party: Party) => `${reverses}|${partyKey(party)}`;

export function assertBalanced(p: Posting[], gross: number, providerFee: number): void {
  const credits = sumBy(p, isCredit);
  const fees = sumBy(p, (x) => x.kind === "fee");
  if (credits !== gross) throw new SplitError(`credits ${credits} != gross ${gross}`);
  if (fees !== -providerFee) throw new SplitError(`fees ${fees} != -${providerFee}`);
}
