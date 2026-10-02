/**
 * Bill matching (SPEC 5) as a pure function: given what a tap knows about the tag, the merchant
 * and the live bills on that tag, decide what happens. Handlers load the inputs, call
 * `decideTap`, then perform the decision with compare-and-set writes; the race between two
 * phones is settled by the database, not here.
 */

export const MERCHANT_MODES = ["appointment", "counter", "table", "quick_tip", "field", "remote_invoice"] as const;
export type MerchantMode = (typeof MERCHANT_MODES)[number];

export type NoBillAction = "none" | "ask_amount" | "quick_tip";

/**
 * What a tap on a tag with no bill does, per mode (SPEC 3). A merchant may override
 * `none`/`ask_amount` (e.g. a cafe till where the customer types the amount); quick_tip is the
 * mode itself.
 */
export function noBillAction(mode: MerchantMode, override: "none" | "ask_amount" | null): NoBillAction {
  if (mode === "quick_tip") return "quick_tip";
  return override ?? "none";
}

export interface TapBill {
  id: string;
  status: "open" | "claimed";
  /** Who holds the claim, if claimed. */
  customerId: string | null;
  /** null: no intended customer (tag-claimable). true/false: addressed to this customer or not. */
  addressedToMe: boolean | null;
  /** Bill split into shares: payers pick a share instead of claiming the bill. */
  hasShares: boolean;
}

export interface TapInput {
  mode: MerchantMode;
  noBillActionOverride: "none" | "ask_amount" | null;
  customerId: string;
  bills: TapBill[];
  /** Customer is locked out of bill codes on this tag (3 wrong tries, 15 minutes). */
  codeLocked: boolean;
  /** Reference (e.g. receipt token) of a bill on this tag this customer paid recently. */
  recentlyPaidByMe: string | null;
}

export type TapDecision =
  | { kind: "resume"; billId: string }
  | { kind: "claim"; billId: string }
  | { kind: "choose_bill"; billIds: string[] }
  | { kind: "choose_share"; billId: string }
  | { kind: "code_needed" }
  | { kind: "code_locked" }
  | { kind: "locked" }
  | { kind: "ask_amount" }
  | { kind: "quick_tip" }
  | { kind: "paid_already"; ref: string }
  | { kind: "none" };

export function decideTap(i: TapInput): TapDecision {
  // 1. Quick tip mode: no bill at all.
  if (i.mode === "quick_tip") return { kind: "quick_tip" };

  // Customer taps twice: carry on with the bill they already hold.
  const mine = i.bills.find((b) => b.status === "claimed" && b.customerId === i.customerId);
  if (mine) return { kind: "resume", billId: mine.id };

  // A split bill on this tag: pick a share (several payers in parallel).
  const shared = i.bills.find((b) => b.hasShares);
  if (shared) return { kind: "choose_share", billId: shared.id };

  // 2. Open bills addressed to this number. Several: let the customer choose.
  const addressed = i.bills.filter((b) => b.status === "open" && b.addressedToMe === true);
  if (addressed.length === 1) return { kind: "claim", billId: addressed[0]!.id };
  if (addressed.length > 1) return { kind: "choose_bill", billIds: addressed.map((b) => b.id) };

  // 3. The tag's one claimable bill (no intended customer): first tap claims it.
  const claimable = i.bills.find((b) => b.status === "open" && b.addressedToMe === null);
  if (claimable) return { kind: "claim", billId: claimable.id };

  // 4. Being paid from another phone.
  if (i.bills.some((b) => b.status === "claimed")) return { kind: "locked" };

  // 5. Bills addressed to other numbers: ask for the 4-digit code (unless locked out).
  if (i.bills.some((b) => b.status === "open" && b.addressedToMe === false)) {
    return i.codeLocked ? { kind: "code_locked" } : { kind: "code_needed" };
  }

  // Customer taps a bill they already paid: send the slip again.
  if (i.recentlyPaidByMe) return { kind: "paid_already", ref: i.recentlyPaidByMe };

  // 7. Open-amount tags create the bill from what the customer types. 6. Otherwise nothing to pay.
  return noBillAction(i.mode, i.noBillActionOverride) === "ask_amount" ? { kind: "ask_amount" } : { kind: "none" };
}

/** 4-digit bill code (SPEC 5): attempts and lockout. */
export const BILL_CODE_MAX_ATTEMPTS = 3;
export const BILL_CODE_LOCK_MINUTES = 15;

export function parseBillCode(text: string): string | null {
  const m = /^\s*(\d{4})\s*$/.exec(text);
  return m ? m[1]! : null;
}

/** Split an amount into n equal shares; the remainder cents go to the first shares. */
export function equalShares(total: number, n: number): number[] {
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("total must be positive cents");
  if (!Number.isInteger(n) || n < 2 || n > 10) throw new Error("between 2 and 10 shares");
  if (total < n) throw new Error("fewer cents than shares");
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, k) => base + (k < rem ? 1 : 0));
}
