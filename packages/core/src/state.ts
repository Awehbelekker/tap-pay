/**
 * Bill and session state machines (SPEC 6). Pure functions: handlers call `next*()` and write
 * the result with a version check; they never set a status directly. Illegal transitions throw
 * IllegalTransition and every (state, event) pair is covered by tests.
 */

export const BILL_STATES = [
  "open",
  "claimed",
  "paid",
  "cancelled",
  "expired",
  "abandoned",
  "needs_follow_up",
  "written_off",
  "paid_other",
] as const;
export type BillState = (typeof BILL_STATES)[number];

export const BILL_EVENTS = [
  "claim",
  "release",
  "pay",
  "cancel",
  "expire",
  "abandon",
  "follow_up",
  "mark_paid_other",
  "write_off",
] as const;
export type BillEvent = (typeof BILL_EVENTS)[number];

export const SESSION_STATES = [
  "claimed",
  "awaiting_amount",
  "awaiting_tip",
  "awaiting_confirm",
  "awaiting_payment",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_EVENTS = [
  "ask_amount",
  "ask_tip",
  "skip_tip",
  "choose_tip",
  "change_tip",
  "change_amount",
  "pay_now",
  "payment_succeeded",
  "payment_failed",
  "expire",
  "cancel",
  "refund_full",
  "refund_partial",
] as const;
export type SessionEvent = (typeof SESSION_EVENTS)[number];

export class IllegalTransition extends Error {
  constructor(
    public readonly machine: "bill" | "session" | "share",
    public readonly from: string,
    public readonly event: string,
  ) {
    super(`illegal ${machine} transition: ${event} from ${from}`);
    this.name = "IllegalTransition";
  }
}

const BILL: Record<BillEvent, Partial<Record<BillState, BillState>>> = {
  claim: { open: "claimed" },
  // Merchant release, or a claim left idle past SESSION_TTL.
  release: { claimed: "open" },
  pay: { open: "paid", claimed: "paid", abandoned: "paid", needs_follow_up: "paid" },
  cancel: { open: "cancelled", claimed: "cancelled", abandoned: "cancelled", needs_follow_up: "cancelled" },
  expire: { open: "expired" },
  abandon: { claimed: "abandoned" },
  follow_up: { abandoned: "needs_follow_up" },
  mark_paid_other: { abandoned: "paid_other", needs_follow_up: "paid_other", open: "paid_other", claimed: "paid_other" },
  write_off: { abandoned: "written_off", needs_follow_up: "written_off" },
};

const PRE_PAYMENT: SessionState[] = ["claimed", "awaiting_amount", "awaiting_tip", "awaiting_confirm"];

const SESSION: Record<SessionEvent, Partial<Record<SessionState, SessionState>>> = {
  ask_amount: { claimed: "awaiting_amount" },
  ask_tip: { claimed: "awaiting_tip", awaiting_amount: "awaiting_tip" },
  // Tips disabled for the merchant: go straight to confirmation (SPEC 6.2 addition, M1).
  skip_tip: { claimed: "awaiting_confirm", awaiting_amount: "awaiting_confirm" },
  choose_tip: { awaiting_tip: "awaiting_confirm" },
  change_tip: { awaiting_confirm: "awaiting_tip" },
  // Quick tip and open amount: back to typing or choosing the amount.
  change_amount: { awaiting_confirm: "awaiting_amount" },
  pay_now: { awaiting_confirm: "awaiting_payment" },
  // The provider's confirmation is the truth: money was taken, so a late success is recorded
  // even after the session expired, failed or was cancelled (SPEC edge case "webhook is late").
  payment_succeeded: { awaiting_payment: "paid", expired: "paid", failed: "paid", cancelled: "paid" },
  payment_failed: { awaiting_payment: "failed" },
  expire: Object.fromEntries([...PRE_PAYMENT, "awaiting_payment"].map((s) => [s, "expired"])),
  cancel: Object.fromEntries([...PRE_PAYMENT, "awaiting_payment"].map((s) => [s, "cancelled"])),
  refund_full: { paid: "refunded", partially_refunded: "refunded" },
  refund_partial: { paid: "partially_refunded", partially_refunded: "partially_refunded" },
};

export function nextBill(from: BillState, event: BillEvent): BillState {
  const to = BILL[event][from];
  if (!to) throw new IllegalTransition("bill", from, event);
  return to;
}

export function nextSession(from: SessionState, event: SessionEvent): SessionState {
  const to = SESSION[event][from];
  if (!to) throw new IllegalTransition("session", from, event);
  return to;
}

export function canSession(from: SessionState, event: SessionEvent): boolean {
  return SESSION[event][from] !== undefined;
}

export function canBill(from: BillState, event: BillEvent): boolean {
  return BILL[event][from] !== undefined;
}

/** States in which a session is still being worked on by the customer. */
export const ACTIVE_SESSION_STATES: SessionState[] = [...PRE_PAYMENT, "awaiting_payment"];

export const TERMINAL_BILL_STATES: BillState[] = ["paid", "paid_other", "written_off", "cancelled", "expired"];

// ── Bill shares (SPEC 5 groups) ─────────────────────────────────────────────

export const SHARE_STATES = ["open", "claimed", "paid", "cancelled"] as const;
export type ShareState = (typeof SHARE_STATES)[number];
export const SHARE_EVENTS = ["claim", "release", "pay", "cancel"] as const;
export type ShareEvent = (typeof SHARE_EVENTS)[number];

const SHARE: Record<ShareEvent, Partial<Record<ShareState, ShareState>>> = {
  claim: { open: "claimed" },
  release: { claimed: "open" },
  // A late success after the claim was released is still money taken: record it.
  pay: { claimed: "paid", open: "paid" },
  cancel: { open: "cancelled", claimed: "cancelled" },
};

export function nextShare(from: ShareState, event: ShareEvent): ShareState {
  const to = SHARE[event][from];
  if (!to) throw new IllegalTransition("share", from, event);
  return to;
}

export function canShare(from: ShareState, event: ShareEvent): boolean {
  return SHARE[event][from] !== undefined;
}
