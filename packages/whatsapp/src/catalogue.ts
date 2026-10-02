import { formatRands, percentTip, type Cents, type WaButton, type WaListRow } from "@tappay/core";

/**
 * Typed message catalogue (MESSAGES.md). Every customer message is built here, never inline in
 * handlers. English only for now; `Lang` is the hook for `af` and `xh`.
 * Rules: name the merchant, show exact totals before Pay now, never ask for card details, no
 * emoji, keep it short.
 */
export type Lang = "en";

export type OutMessage =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: WaButton[] }
  | { kind: "list"; body: string; buttonLabel: string; rows: WaListRow[] }
  | { kind: "image"; imageUrl: string; caption: string };

/** Interactive reply ids. Handlers switch on these, never on titles. */
export const IDS = {
  tipNone: "tip_none",
  tipCustom: "tip_custom",
  tipPercent: (bp: number) => `tip_bp_${bp}`,
  payNow: "pay_now",
  changeTip: "change_tip",
  cancel: "cancel",
  tryAgain: "try_again",
  quickTip: (c: number) => `qt_${c}`,
  quickTipOther: "qt_other",
  bill: (id: string) => `bill_${id}`,
  share: (id: string) => `share_${id}`,
} as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function parseBillId(id: string): string | null {
  return new RegExp(`^bill_(${UUID})$`).exec(id)?.[1] ?? null;
}
export function parseShareId(id: string): string | null {
  return new RegExp(`^share_(${UUID})$`).exec(id)?.[1] ?? null;
}
export function parseQuickTipId(id: string): number | "other" | null {
  if (id === IDS.quickTipOther) return "other";
  const m = /^qt_(\d{1,9})$/.exec(id);
  return m ? Number(m[1]) : null;
}

export function parseTipId(id: string): { kind: "none" } | { kind: "custom" } | { kind: "percent"; bp: number } | null {
  if (id === IDS.tipNone) return { kind: "none" };
  if (id === IDS.tipCustom) return { kind: "custom" };
  const m = /^tip_bp_(\d{1,5})$/.exec(id);
  if (m) {
    const bp = Number(m[1]);
    if (bp > 0 && bp <= 10000) return { kind: "percent", bp };
  }
  return null;
}

const R = formatRands;

export const catalogue = {
  /** Fixed bill claimed: show it and ask for a tip (list, so "No tip" is one tap; OPEN_QUESTIONS O2). */
  claimFixed(i: { merchant: string; description: string; base: Cents; staff: string | null; tipPercents: number[] }): OutMessage {
    const who = i.staff ? ` for ${i.staff}` : "";
    return {
      kind: "list",
      body: `${i.merchant}\n${i.description}: ${R(i.base)}\nAdd a tip${who}?`,
      buttonLabel: "Choose tip",
      rows: [
        { id: IDS.tipNone, title: "No tip" },
        ...i.tipPercents.slice(0, 4).map((p) => ({
          id: IDS.tipPercent(p * 100),
          title: `${p}% (${R(percentTip(i.base, p * 100))})`,
        })),
        { id: IDS.tipCustom, title: "Other amount" },
      ],
    };
  },

  tipCustomAsk(): OutMessage {
    return { kind: "text", body: "Type the tip in rand, for example 25, or as a percentage, for example 12%." };
  },

  tipCustomInvalid(i: { min: Cents; max: Cents; maxPercent: number }): OutMessage {
    const pct = Number.isInteger(i.maxPercent) ? `${i.maxPercent}` : i.maxPercent.toFixed(2).replace(".", ",");
    return {
      kind: "buttons",
      body: `Please send an amount between ${R(i.min)} and ${R(i.max)}, or a percentage up to ${pct}%, or tap No tip.`,
      buttons: [{ id: IDS.tipNone, title: "No tip" }],
    };
  },

  /** `tipsEnabled: false` (merchant takes no tips): no tip line and no Change tip button. */
  confirm(i: { merchant: string; description: string; base: Cents; tip: Cents; tipsEnabled?: boolean }): OutMessage {
    const total = (i.base + i.tip) as Cents;
    const tips = i.tipsEnabled ?? true;
    return {
      kind: "buttons",
      body: `Pay ${R(total)} to ${i.merchant}?\n${i.description}: ${R(i.base)}${tips ? `\nTip: ${R(i.tip)}` : ""}`,
      buttons: [
        { id: IDS.payNow, title: "Pay now" },
        ...(tips ? [{ id: IDS.changeTip, title: "Change tip" }] : []),
        { id: IDS.cancel, title: "Cancel" },
      ],
    };
  },

  payLink(i: { merchant: string; total: Cents; url: string; minutes: number }): OutMessage {
    // Raw URL: WhatsApp does not render markdown links.
    return {
      kind: "text",
      body: `Pay ${R(i.total)} to ${i.merchant} with Apple Pay, Google Pay or your bank:\n${i.url}\nThe link works for ${i.minutes} minutes.`,
    };
  },

  paySuccess(i: { merchant: string; total: Cents; receiptUrl: string; slipUrl: string }): OutMessage {
    return { kind: "image", imageUrl: i.slipUrl, caption: `Paid ${R(i.total)} to ${i.merchant}. Thank you.\nReceipt: ${i.receiptUrl}` };
  },

  payFailed(i: { merchant: string }): OutMessage {
    return {
      kind: "buttons",
      body: `That payment to ${i.merchant} did not go through. No money was taken.`,
      buttons: [
        { id: IDS.tryAgain, title: "Try again" },
        { id: IDS.cancel, title: "Cancel" },
      ],
    };
  },

  sessionExpired(): OutMessage {
    return { kind: "text", body: "This payment has expired. Tap the tag again to start over." };
  },

  cancelled(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `Cancelled. Nothing was charged. Tap the tag again to pay ${i.merchant}.` };
  },

  billClaimedOther(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `This bill is being paid from another phone. Ask ${i.merchant} to release it.` };
  },

  billNone(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `${i.merchant} has no bill ready yet. Ask them to create one, then tap again.` };
  },

  billPaidAlready(i: { merchant: string; receiptUrl: string }): OutMessage {
    return { kind: "text", body: `This bill at ${i.merchant} is already paid. Your receipt: ${i.receiptUrl}` };
  },

  tokenInvalid(): OutMessage {
    return { kind: "text", body: "This pay code has expired or was already used. Tap the tag again." };
  },

  tagNotVerified(): OutMessage {
    return { kind: "text", body: "We could not verify this tag. Please ask staff to take payment another way." };
  },

  paymentPending(i: { merchant: string; url: string }): OutMessage {
    return { kind: "text", body: `Your payment to ${i.merchant} is still open. Use this link to finish:\n${i.url}` };
  },

  chooseBill(i: { merchant: string; bills: { id: string; description: string; amount: Cents }[] }): OutMessage {
    return {
      kind: "list",
      body: `${i.merchant} has more than one bill for you. Which one are you paying?`,
      buttonLabel: "Choose bill",
      rows: i.bills.slice(0, 10).map((b) => ({ id: IDS.bill(b.id), title: R(b.amount), description: b.description.slice(0, 72) })),
    };
  },

  chooseShare(i: { merchant: string; total: Cents; shares: { id: string; label: string; amount: Cents }[] }): OutMessage {
    return {
      kind: "list",
      body: `${i.merchant}\nThis bill is ${R(i.total)}, split into shares. Which share are you paying?`,
      buttonLabel: "Choose share",
      rows: i.shares.slice(0, 10).map((x) => ({ id: IDS.share(x.id), title: `${x.label}`.slice(0, 24), description: R(x.amount) })),
    };
  },

  sharesTaken(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `Every share of this bill at ${i.merchant} is already being paid or paid.` };
  },

  codeAsk(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `This bill at ${i.merchant} was sent to another number. Enter the 4-digit code from the merchant.` };
  },

  codeBad(i: { left: number }): OutMessage {
    return { kind: "text", body: `That code does not match. ${i.left} ${i.left === 1 ? "try" : "tries"} left.` };
  },

  codeLocked(i: { merchant: string; minutes: number }): OutMessage {
    return { kind: "text", body: `Too many tries. Please ask ${i.merchant} for help, or try again in ${i.minutes} minutes.` };
  },

  askAmount(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `Enter the amount to pay ${i.merchant}, in rand. For example 85,50.` };
  },

  amountInvalid(i: { max: Cents }): OutMessage {
    return { kind: "text", body: `Please send an amount between R1,00 and ${R(i.max)}, for example 85,50.` };
  },

  quickTip(i: { merchant: string; staff: string | null; presets: Cents[] }): OutMessage {
    const who = i.staff ? `${i.staff} at ${i.merchant}` : i.merchant;
    // A list, not buttons: Meta caps reply buttons at 3 and the presets plus Other are 4.
    return {
      kind: "list",
      body: `Tip ${who}. How much?`,
      buttonLabel: "Choose amount",
      rows: [...i.presets.slice(0, 9).map((c) => ({ id: IDS.quickTip(c), title: R(c) })), { id: IDS.quickTipOther, title: "Other amount" }],
    };
  },

  quickTipAsk(i: { min: Cents; max: Cents }): OutMessage {
    return { kind: "text", body: `Type the tip in rand, between ${R(i.min)} and ${R(i.max)}.` };
  },

  quickTipInvalid(i: { min: Cents; max: Cents }): OutMessage {
    return { kind: "text", body: `Please send an amount between ${R(i.min)} and ${R(i.max)}.` };
  },

  confirmQuickTip(i: { merchant: string; staff: string | null; amount: Cents }): OutMessage {
    const who = i.staff ? `${i.staff} at ${i.merchant}` : i.merchant;
    return {
      kind: "buttons",
      body: `Tip ${R(i.amount)} to ${who}?`,
      buttons: [
        { id: IDS.payNow, title: "Pay now" },
        { id: IDS.changeTip, title: "Change amount" },
        { id: IDS.cancel, title: "Cancel" },
      ],
    };
  },

  billReleased(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `${i.merchant} released this bill, so nothing will be charged. Tap the tag again if you still need to pay.` };
  },

  billCancelledByMerchant(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `${i.merchant} cancelled this bill. Nothing was charged.` };
  },

  amountChanged(i: { merchant: string }): OutMessage {
    return { kind: "text", body: `${i.merchant} changed the amount on your bill. Please check it again before you pay.` };
  },

  /** MESSAGES.md refund.notice */
  refundNotice(i: { merchant: string; amount: Cents }): OutMessage {
    return { kind: "text", body: `${R(i.amount)} was refunded by ${i.merchant}. It can take a few days to show.` };
  },

  stopOk(): OutMessage {
    return { kind: "text", body: "Done. You will not get reminders from us." };
  },

  fallback(): OutMessage {
    return { kind: "text", body: "Sorry, I did not understand. Tap the tag again to pay, or reply HELP." };
  },

  help(): OutMessage {
    return { kind: "text", body: "To pay, tap the merchant's tag and send the message that opens. Reply STOP to stop reminders." };
  },
};
