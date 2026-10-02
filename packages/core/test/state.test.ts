import { describe, expect, it } from "vitest";
import {
  BILL_EVENTS,
  BILL_STATES,
  IllegalTransition,
  nextBill,
  nextSession,
  SESSION_EVENTS,
  SESSION_STATES,
  type BillEvent,
  type BillState,
  type SessionEvent,
  type SessionState,
} from "../src/state.js";

/**
 * Exhaustive tables: every (state, event) pair is listed with its expected result or null
 * (illegal). Adding a state or event without updating these tables fails the "covers every
 * pair" test.
 */
const BILL_EXPECT: Record<BillState, Partial<Record<BillEvent, BillState>>> = {
  open: { claim: "claimed", pay: "paid", cancel: "cancelled", expire: "expired", mark_paid_other: "paid_other" },
  claimed: { release: "open", pay: "paid", cancel: "cancelled", abandon: "abandoned", mark_paid_other: "paid_other" },
  paid: {},
  cancelled: {},
  expired: {},
  abandoned: { claim: "claimed", pay: "paid", cancel: "cancelled", follow_up: "needs_follow_up", mark_paid_other: "paid_other", write_off: "written_off" },
  needs_follow_up: { claim: "claimed", pay: "paid", cancel: "cancelled", mark_paid_other: "paid_other", write_off: "written_off" },
  written_off: {},
  paid_other: {},
};

const pre = { expire: "expired", cancel: "cancelled" } as const;
const SESSION_EXPECT: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  claimed: { ask_amount: "awaiting_amount", ask_tip: "awaiting_tip", skip_tip: "awaiting_confirm", ...pre },
  awaiting_amount: { ask_tip: "awaiting_tip", skip_tip: "awaiting_confirm", ...pre },
  awaiting_tip: { choose_tip: "awaiting_confirm", ...pre },
  awaiting_confirm: { change_tip: "awaiting_tip", change_amount: "awaiting_amount", pay_now: "awaiting_payment", ...pre },
  awaiting_payment: { payment_succeeded: "paid", payment_failed: "failed", ...pre },
  paid: { refund_full: "refunded", refund_partial: "partially_refunded" },
  failed: { payment_succeeded: "paid" },
  expired: { payment_succeeded: "paid" },
  cancelled: { payment_succeeded: "paid" },
  refunded: {},
  partially_refunded: { refund_full: "refunded", refund_partial: "partially_refunded" },
};

describe("bill state machine", () => {
  for (const s of BILL_STATES) {
    for (const e of BILL_EVENTS) {
      const want = BILL_EXPECT[s][e];
      it(`${s} --${e}--> ${want ?? "illegal"}`, () => {
        if (want) expect(nextBill(s, e)).toBe(want);
        else expect(() => nextBill(s, e)).toThrow(IllegalTransition);
      });
    }
  }

  it("terminal states accept no event", () => {
    for (const s of ["paid", "cancelled", "expired", "written_off", "paid_other"] as const) {
      for (const e of BILL_EVENTS) expect(() => nextBill(s, e)).toThrow(IllegalTransition);
    }
  });
});

describe("session state machine", () => {
  for (const s of SESSION_STATES) {
    for (const e of SESSION_EVENTS) {
      const want = SESSION_EXPECT[s][e];
      it(`${s} --${e}--> ${want ?? "illegal"}`, () => {
        if (want) expect(nextSession(s, e)).toBe(want);
        else expect(() => nextSession(s, e)).toThrow(IllegalTransition);
      });
    }
  }

  it("refunded is terminal", () => {
    for (const e of SESSION_EVENTS) expect(() => nextSession("refunded", e)).toThrow(IllegalTransition);
  });
});
