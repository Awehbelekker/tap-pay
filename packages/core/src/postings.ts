import { cents, type Cents } from "./money.js";

/**
 * Ledger postings for one confirmed payment. M1 implements the `ledger_only` default with no
 * revenue split: the sale goes to the merchant and the tip goes directly to the staff member
 * tied to the bill or tag (tip_rule `direct`), or to the merchant when nobody is tied. M5 adds
 * split rules, pools and house cut on top of this same shape.
 *
 * Invariant (SPEC 8.2): sum of credit lines == gross, and the provider fee is a separate debit.
 */

export interface Posting {
  kind: "sale" | "tip" | "fee";
  partyKind: "merchant" | "staff" | "pool";
  partyUserId: string | null;
  /** Signed: credits positive, debits negative. */
  amount: number;
}

export function postingsForPayment(i: {
  base: Cents;
  tip: Cents;
  fee: Cents;
  tipStaffUserId: string | null;
}): Posting[] {
  const gross = i.base + i.tip;
  if (i.fee > gross) throw new Error("provider fee exceeds payment");
  const out: Posting[] = [];
  if (i.base > 0) out.push({ kind: "sale", partyKind: "merchant", partyUserId: null, amount: i.base });
  if (i.tip > 0) {
    out.push(
      i.tipStaffUserId
        ? { kind: "tip", partyKind: "staff", partyUserId: i.tipStaffUserId, amount: i.tip }
        : { kind: "tip", partyKind: "merchant", partyUserId: null, amount: i.tip },
    );
  }
  // Fee allocation across parties is M5 (SPEC 8.1); until then the merchant absorbs it.
  if (i.fee > 0) out.push({ kind: "fee", partyKind: "merchant", partyUserId: null, amount: -i.fee });
  return out;
}

export function sumCredits(p: Posting[]): Cents {
  return cents(p.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0));
}
