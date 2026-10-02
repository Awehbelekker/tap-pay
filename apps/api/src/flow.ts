import { randomInt } from "node:crypto";
import type { Kysely } from "@tappay/db";
import type { FastifyBaseLogger } from "fastify";
import {
  BILL_CODE_LOCK_MINUTES,
  BILL_CODE_MAX_ATTEMPTS,
  canBill,
  canSession,
  canShare,
  cents,
  decideTap,
  equalShares,
  hashToken,
  newClaimToken,
  newUrlToken,
  nextSession,
  parseBillCode,
  parsePayCommand,
  offeredPresets,
  parseRands,
  parseTipText,
  resolveTip,
  tipCap,
  type TipChoice,
  type TipPolicy,
  type Cents,
  type Clock,
  type PaymentProvider,
  type SessionState,
  type TapDecision,
  type VerifiedEvent,
  type WhatsAppClient,
} from "@tappay/core";
import type { Config } from "@tappay/config";
import {
  activeSessionsOnBill,
  audit,
  awaitingCodePrompt,
  billByToken,
  consumeClaimToken,
  createBill,
  createReceipt,
  createSession,
  customerMsisdn,
  findTagForTap,
  getBill,
  getCodePrompt,
  getShare,
  insertClaimToken,
  insertPendingPayment,
  latestActiveSession,
  linesTotal,
  listShares,
  liveBillsOnTag,
  lockPaymentByProviderRef,
  logMessage,
  openBillByCode,
  optOutGlobally,
  pendingPaymentForSession,
  receiptByPayment,
  recentlyPaidOnTag,
  setBillLines,
  setCodePrompt,
  settlePayment,
  transitionBill,
  transitionSession,
  transitionShare,
  unpaidShareCount,
  upsertCustomer,
  type BillLine,
  type Crypto,
  type Database,
} from "@tappay/db";
import { isValidTagCode, waMeLink } from "@tappay/tag";
import { postPayment, staffShares, type Money } from "./money.js";
import type { FlowEvents } from "./notifier.js";
import {
  catalogue,
  IDS,
  parseBillId,
  parseQuickTipId,
  parseShareId,
  parseTipId,
  type InboundMessage,
  type OutMessage,
} from "@tappay/whatsapp";

/**
 * The customer pay flow (SPEC 4 and 5): tap or bill link -> match -> claim a bill or a share,
 * or enter an amount / quick tip -> tip -> confirm -> hosted checkout -> provider webhook ->
 * paid -> slip. Merchant actions (create, release, edit, cancel) live here too so the M4
 * merchant API is a thin authenticated layer over them.
 *
 * Every handler is safe to run twice: state changes are compare-and-set through the state
 * machines, inbound events are de-duplicated by the caller, and checkout creation is keyed by
 * session id + version.
 */

export interface FlowDeps {
  /** Live events and staff alerts (M4). Optional so the flow runs without them in tests. */
  events?: FlowEvents;
  /** Refunds and chargebacks arriving by provider webhook (M5). */
  money?: Money;
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  wa: WhatsAppClient;
  provider: PaymentProvider;
  clock: Clock;
  log: FastifyBaseLogger;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MIN_OPEN_AMOUNT = 100;
const CODE_PROMPT_MINUTES = 10;
const SLIP_AGAIN_WINDOW = 2 * HOUR;

function describeLines(lines: BillLine[] | null | undefined): string {
  const names = (lines ?? []).map((l) => l.description).filter(Boolean);
  return names.length ? names.join(", ") : "Bill";
}

type ActiveSession = NonNullable<Awaited<ReturnType<typeof latestActiveSession>>>;

function tipPolicy(s: ActiveSession): TipPolicy {
  return { presetsPercent: s.tipPresets, minCents: s.tipMin, maxBp: s.tipMaxBp, maxCents: s.tipMaxCents };
}
type TagContext = NonNullable<Awaited<ReturnType<typeof findTagForTap>>>;

export class FlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FlowError";
  }
}

export interface NewBillInput {
  merchantId: string;
  createdBy: string | null;
  /** Tag the customer will tap (appointment, counter, table). Omit for field/remote links. */
  tagCode?: string | null;
  lines: BillLine[];
  /** E.164 or local number: enables number match and the 4-digit code for other numbers. */
  customerMsisdn?: string | null;
  tableLabel?: string | null;
  /** Split into shares: n equal shares, or explicit amounts that sum to the total. */
  shares?: { equal: number } | { amounts: { label: string; amountCents: number }[] };
  /** Staff member the tip goes to; defaults to the tag's assigned person. */
  assignedUserId?: string | null;
}

export class PayFlow {
  constructor(private readonly d: FlowDeps) {}

  private now(): Date {
    return this.d.clock.now();
  }

  /** Tell the merchant PWA. Never lets a notification problem break the customer's flow. */
  private async notify(fn: (e: FlowEvents) => Promise<void>): Promise<void> {
    if (!this.d.events) return;
    try {
      await fn(this.d.events);
    } catch (e) {
      this.d.log.error({ err: (e as Error).message }, "merchant event failed");
    }
  }

  private async billEvent(merchantId: string, billId: string, name: string): Promise<void> {
    const bill = await getBill(this.d.db, merchantId, billId);
    await this.notify((e) =>
      e.billChanged({ merchantId, billId, name, staffUserId: bill?.assigned_user_id ?? null, createdBy: bill?.created_by ?? null, payload: { status: bill?.status } }),
    );
  }

  private sessionExpiry(): Date {
    return new Date(this.now().getTime() + this.d.config.SESSION_TTL_MINUTES * MINUTE);
  }

  // ── Entry points: tag tap and bill link ────────────────────────────────────

  /** Returns where to send the phone, or null for the generic "take payment another way" page. */
  async tapRedirect(code: string): Promise<string | null> {
    const { config, db } = this.d;
    if (!isValidTagCode(code)) return null;
    const tag = await findTagForTap(db, { code });
    if (!tag || tag.tagStatus !== "active" || tag.merchantStatus !== "active") return null;

    if (tag.kind === "static") {
      if (config.NODE_ENV === "production" && !config.ALLOW_STATIC_TAGS) return null;
    } else {
      // NTAG424 SDM verification lands in M9; refuse rather than accept an unverified tap.
      await audit(db, { merchantId: tag.merchantId, actorKind: "system", actorId: null, action: "tap.unverified", entity: "tag", entityId: tag.tagId });
      return null;
    }
    return this.mintRedirect({ tagId: tag.tagId, billId: null, merchantId: tag.merchantId });
  }

  /**
   * Bill link or QR (SPEC 5 rule 5): `/b/<bill token>` carries the bill id, so there is no
   * ambiguity when several customers wait. Possession of the unguessable link is the
   * authorisation; anyone holding it may pay (SPEC 5: someone else may pay a bill).
   */
  async billLinkRedirect(billToken: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(billToken)) return null;
    const bill = await billByToken(this.d.db, billToken);
    if (!bill || (bill.status !== "open" && bill.status !== "claimed") || bill.expires_at <= this.now()) return null;
    return this.mintRedirect({ tagId: bill.tag_id, billId: bill.id, merchantId: bill.merchant_id });
  }

  private async mintRedirect(i: { tagId: string | null; billId: string | null; merchantId: string }): Promise<string | null> {
    const { config, db } = this.d;
    const expiresAt = new Date(this.now().getTime() + config.CLAIM_TOKEN_TTL_SECONDS * 1000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = newClaimToken();
      try {
        await insertClaimToken(db, { hash: hashToken(token, config.HASH_PEPPER), tagId: i.tagId, billId: i.billId, merchantId: i.merchantId, expiresAt });
      } catch {
        continue; // hash collision with a live token: draw again
      }
      return config.WA_MODE === "sim"
        ? `${config.WA_SIM_URL}/?text=${encodeURIComponent(`PAY ${token}`)}`
        : waMeLink(config.WA_PHONE_NUMBER, token);
    }
    return null;
  }

  // ── Inbound WhatsApp ───────────────────────────────────────────────────────

  async handleInbound(m: InboundMessage): Promise<void> {
    const { db, crypto } = this.d;
    const customerId = await upsertCustomer(db, crypto, m.from, m.profileName);
    await logMessage(db, { customerId, merchantId: null, direction: "in", waMessageId: m.messageId, kind: m.kind });
    const reply = (msg: OutMessage, merchantId: string | null = null) => this.send(m.from, customerId, merchantId, msg);

    if (m.kind === "text") {
      const token = parsePayCommand(m.text);
      if (token) return this.onPay(m.from, customerId, token);
      const word = m.text.trim().toUpperCase();
      if (word === "HELP") return reply(catalogue.help());
      if (word === "STOP" || word === "STOP ALL") {
        await optOutGlobally(db, customerId, this.now());
        await audit(db, { merchantId: null, actorKind: "customer", actorId: customerId, action: "customer.opt_out", entity: "customer", entityId: customerId });
        return reply(catalogue.stopOk());
      }
      // A 4-digit bill code, when we just asked for one.
      const code = parseBillCode(m.text);
      if (code) {
        const prompt = await awaitingCodePrompt(db, customerId, this.now());
        if (prompt) return this.onBillCode(m.from, customerId, prompt.tag_id, code);
      }
    }

    // Choosing a bill or a share happens before any session exists.
    if (m.kind === "reply") {
      const billId = parseBillId(m.replyId);
      if (billId) return this.onChooseBill(m.from, customerId, billId);
      const shareId = parseShareId(m.replyId);
      if (shareId) return this.onChooseShare(m.from, customerId, shareId);
    }

    const s = await this.liveSession(m.from, customerId);
    if (s === "expired") return; // the expiry notice was the reply
    if (!s) return reply(catalogue.fallback());

    if (m.kind === "text" && s.status === "awaiting_tip") return this.onCustomTip(m.from, customerId, s, m.text);
    if (m.kind === "text" && s.status === "awaiting_amount") return this.onAmountText(m.from, customerId, s, m.text);
    if (m.kind === "reply") return this.onReply(m.from, customerId, s, m.replyId);
    return this.resendPrompt(m.from, customerId, s);
  }

  /**
   * The customer's in-progress session. If its time ran out, expire it, release what it held,
   * tell the customer, and return "expired".
   */
  private async liveSession(to: string, customerId: string): Promise<ActiveSession | "expired" | null> {
    const { db } = this.d;
    const s = await latestActiveSession(db, customerId);
    if (!s) return null;
    if (s.expiresAt.getTime() > this.now().getTime()) return s;
    if (canSession(s.status, "expire")) await transitionSession(db, s.id, s.status, "expire");
    await this.releaseHold(s, customerId);
    await this.send(to, customerId, s.merchantId, catalogue.sessionExpired());
    return "expired";
  }

  /** Give back what a session held: its share, or the whole bill. */
  private async releaseHold(s: { merchantId: string; billId: string | null; shareId: string | null }, customerId: string): Promise<void> {
    const { db } = this.d;
    if (s.shareId) {
      const share = await getShare(db, s.shareId);
      if (share?.status === "claimed" && share.customer_id === customerId) {
        await transitionShare(db, share.id, "claimed", "release", { customer_id: null, claimed_at: null });
      }
      return;
    }
    if (!s.billId) return;
    const bill = await getBill(db, s.merchantId, s.billId);
    if (bill?.status === "claimed" && bill.customer_id === customerId) {
      if (await transitionBill(db, s.billId, "claimed", "release", { customer_id: null, claimed_at: null })) {
        await this.billEvent(s.merchantId, s.billId, "bill.released");
      }
    }
  }

  private async onPay(to: string, customerId: string, token: string): Promise<void> {
    const { db, config } = this.d;
    const now = this.now();
    const claim = await consumeClaimToken(db, hashToken(token, config.HASH_PEPPER), now);
    if (!claim) return this.send(to, customerId, null, catalogue.tokenInvalid());
    if (claim.billId) return this.onBillLink(to, customerId, claim.merchantId, claim.billId);
    if (!claim.tagId) return this.send(to, customerId, null, catalogue.tokenInvalid());

    const tag = await findTagForTap(db, { id: claim.tagId });
    if (!tag || tag.tagStatus !== "active" || tag.merchantStatus !== "active") {
      return this.send(to, customerId, null, catalogue.tagNotVerified());
    }
    const bills = await liveBillsOnTag(db, tag.merchantId, tag.tagId, now);

    // Already paying something on this tag (a bill or a share): carry on, or restart the step.
    const current = await latestActiveSession(db, customerId);
    if (current && current.status !== "failed" && bills.some((b) => b.id === current.billId)) {
      if (current.expiresAt.getTime() > now.getTime()) return this.resendPrompt(to, customerId, current);
      if (canSession(current.status, "expire")) await transitionSession(db, current.id, current.status, "expire");
      if (current.shareId) await this.releaseHold(current, customerId);
    }

    const myHash = this.d.crypto.lookupHash(to);
    const prompt = await getCodePrompt(db, customerId, tag.tagId);
    const decision = decideTap({
      mode: tag.mode,
      noBillActionOverride: tag.noBillAction,
      customerId,
      // Open-amount and quick-tip bills are created by a tap for one customer: private to them,
      // they never lock the tag for the next person.
      bills: bills
        .filter((b) => b.type === "fixed" || b.customer_id === customerId)
        .map((b) => ({
        id: b.id,
        status: b.status as "open" | "claimed",
        customerId: b.customer_id,
        addressedToMe: b.intended_msisdn_hash ? b.intended_msisdn_hash.equals(myHash) : null,
        hasShares: Boolean(b.has_shares),
      })),
      codeLocked: Boolean(prompt?.locked_until && prompt.locked_until > now),
      recentlyPaidByMe: (await recentlyPaidOnTag(db, tag.merchantId, tag.tagId, customerId, new Date(now.getTime() - SLIP_AGAIN_WINDOW)))?.receiptToken ?? null,
    });
    return this.act(to, customerId, tag, decision);
  }

  private async act(to: string, customerId: string, tag: TagContext, d: TapDecision): Promise<void> {
    const { db } = this.d;
    const merchant = tag.merchantName;
    const say = (msg: OutMessage) => this.send(to, customerId, tag.merchantId, msg);
    switch (d.kind) {
      case "resume": {
        const bill = await getBill(db, tag.merchantId, d.billId);
        if (!bill) return say(catalogue.fallback());
        // A bill made by a tap (open amount, quick tip) restarts at the amount step.
        const amountFirst = bill.type !== "fixed";
        return this.startSession(to, customerId, tag.merchantId, tag.tipsEnabled, { billId: bill.id, base: amountFirst ? 0 : bill.subtotal_cents, amountFirst });
      }
      case "claim":
        return this.claimAndStart(to, customerId, tag.merchantId, tag.tipsEnabled, d.billId, merchant);
      case "choose_bill": {
        const bills = await Promise.all(d.billIds.map((id) => getBill(db, tag.merchantId, id)));
        return say(
          catalogue.chooseBill({
            merchant,
            bills: bills.filter((b) => b !== undefined).map((b) => ({ id: b.id, description: describeLines(b.lines), amount: cents(b.subtotal_cents) })),
          }),
        );
      }
      case "choose_share":
        return this.offerShares(to, customerId, tag.merchantId, d.billId, merchant);
      case "code_needed":
        await setCodePrompt(db, {
          customerId,
          tagId: tag.tagId,
          merchantId: tag.merchantId,
          failures: await this.currentFailures(customerId, tag.tagId),
          awaitingUntil: new Date(this.now().getTime() + CODE_PROMPT_MINUTES * MINUTE),
          lockedUntil: null,
        });
        return say(catalogue.codeAsk({ merchant }));
      case "code_locked": {
        const p = await getCodePrompt(db, customerId, tag.tagId);
        const minutes = p?.locked_until ? Math.max(1, Math.ceil((p.locked_until.getTime() - this.now().getTime()) / MINUTE)) : BILL_CODE_LOCK_MINUTES;
        return say(catalogue.codeLocked({ merchant, minutes }));
      }
      case "locked":
        return say(catalogue.billClaimedOther({ merchant }));
      case "ask_amount":
        return this.startOnTheFly(to, customerId, tag, "open");
      case "quick_tip":
        return this.startOnTheFly(to, customerId, tag, "quick_tip");
      case "paid_already":
        return say(catalogue.billPaidAlready({ merchant, receiptUrl: `${this.d.config.PUBLIC_API_URL}/r/${d.ref}` }));
      case "none":
        return say(catalogue.billNone({ merchant }));
    }
  }

  /** Bill link path: the bill is known, so no tag matching (and no bill code). */
  private async onBillLink(to: string, customerId: string, merchantId: string, billId: string): Promise<void> {
    const { db } = this.d;
    const bill = await getBill(db, merchantId, billId);
    const m = await db.selectFrom("merchants").select(["name", "tips_enabled"]).where("id", "=", merchantId).executeTakeFirst();
    if (!bill || !m) return this.send(to, customerId, merchantId, catalogue.tokenInvalid());
    const current = await latestActiveSession(db, customerId);
    if (current && current.billId === bill.id && current.status !== "failed" && current.expiresAt > this.now()) {
      return this.resendPrompt(to, customerId, current);
    }
    if (bill.status === "open" && (await listShares(db, bill.id)).length > 0) return this.offerShares(to, customerId, merchantId, bill.id, m.name);
    if (bill.status === "open") return this.claimAndStart(to, customerId, merchantId, m.tips_enabled, bill.id, m.name);
    if (bill.status === "claimed" && bill.customer_id === customerId) {
      return this.startSession(to, customerId, merchantId, m.tips_enabled, { billId: bill.id, base: bill.subtotal_cents });
    }
    if (bill.status === "claimed") return this.send(to, customerId, merchantId, catalogue.billClaimedOther({ merchant: m.name }));
    return this.send(to, customerId, merchantId, catalogue.billNone({ merchant: m.name }));
  }

  private async claimAndStart(to: string, customerId: string, merchantId: string, tipsEnabled: boolean, billId: string, merchant: string): Promise<void> {
    const { db } = this.d;
    const won = await transitionBill(db, billId, "open", "claim", { customer_id: customerId, claimed_at: this.now() });
    if (!won) return this.send(to, customerId, merchantId, catalogue.billClaimedOther({ merchant }));
    await audit(db, { merchantId, actorKind: "customer", actorId: customerId, action: "bill.claimed", entity: "bill", entityId: billId });
    await this.billEvent(merchantId, billId, "bill.claimed");
    const bill = await getBill(db, merchantId, billId);
    return this.startSession(to, customerId, merchantId, tipsEnabled, { billId, base: bill?.subtotal_cents ?? 0 });
  }

  private async offerShares(to: string, customerId: string, merchantId: string, billId: string, merchant: string): Promise<void> {
    const { db } = this.d;
    const bill = await getBill(db, merchantId, billId);
    const open = (await listShares(db, billId)).filter((x) => x.status === "open");
    if (!bill || open.length === 0) return this.send(to, customerId, merchantId, catalogue.sharesTaken({ merchant }));
    return this.send(
      to,
      customerId,
      merchantId,
      catalogue.chooseShare({ merchant, total: cents(bill.subtotal_cents), shares: open.map((x) => ({ id: x.id, label: x.label ?? "Share", amount: cents(x.amount_cents) })) }),
    );
  }

  private async onChooseBill(to: string, customerId: string, billId: string): Promise<void> {
    const { db } = this.d;
    const bill = await db
      .selectFrom("bills")
      .innerJoin("merchants", "merchants.id", "bills.merchant_id")
      .select(["bills.id", "bills.merchant_id", "bills.status", "bills.intended_msisdn_hash", "bills.expires_at", "merchants.name", "merchants.tips_enabled"])
      .where("bills.id", "=", billId)
      .executeTakeFirst();
    // Only a bill addressed to this number can be picked this way.
    if (!bill || !bill.intended_msisdn_hash?.equals(this.d.crypto.lookupHash(to)) || bill.expires_at <= this.now()) {
      return this.send(to, customerId, null, catalogue.fallback());
    }
    if (bill.status !== "open") return this.send(to, customerId, bill.merchant_id, catalogue.billClaimedOther({ merchant: bill.name }));
    return this.claimAndStart(to, customerId, bill.merchant_id, bill.tips_enabled, bill.id, bill.name);
  }

  private async onChooseShare(to: string, customerId: string, shareId: string): Promise<void> {
    const { db } = this.d;
    const share = await getShare(db, shareId);
    if (!share) return this.send(to, customerId, null, catalogue.fallback());
    const bill = await getBill(db, share.merchant_id, share.bill_id);
    const m = await db.selectFrom("merchants").select(["name", "tips_enabled"]).where("id", "=", share.merchant_id).executeTakeFirstOrThrow();
    if (!bill || bill.status !== "open" || bill.expires_at <= this.now()) return this.send(to, customerId, share.merchant_id, catalogue.billNone({ merchant: m.name }));
    const won = share.status === "open" && (await transitionShare(db, share.id, "open", "claim", { customer_id: customerId, claimed_at: this.now() }));
    if (!won) return this.offerShares(to, customerId, share.merchant_id, share.bill_id, m.name);
    await audit(db, { merchantId: share.merchant_id, actorKind: "customer", actorId: customerId, action: "share.claimed", entity: "bill_share", entityId: share.id });
    await this.billEvent(share.merchant_id, share.bill_id, "share.claimed");
    return this.startSession(to, customerId, share.merchant_id, m.tips_enabled, { billId: share.bill_id, shareId: share.id, base: share.amount_cents });
  }

  private async currentFailures(customerId: string, tagId: string): Promise<number> {
    const p = await getCodePrompt(this.d.db, customerId, tagId);
    if (!p) return 0;
    // A finished lockout starts the count again.
    if (p.locked_until && p.locked_until <= this.now()) return 0;
    return p.failures;
  }

  private async onBillCode(to: string, customerId: string, tagId: string, code: string): Promise<void> {
    const { db } = this.d;
    const now = this.now();
    const tag = await findTagForTap(db, { id: tagId });
    if (!tag) return this.send(to, customerId, null, catalogue.fallback());
    const merchant = tag.merchantName;
    const p = await getCodePrompt(db, customerId, tagId);
    if (p?.locked_until && p.locked_until > now) return this.act(to, customerId, tag, { kind: "code_locked" });

    const bill = await openBillByCode(db, tag.merchantId, tagId, code, now);
    if (bill) {
      await setCodePrompt(db, { customerId, tagId, merchantId: tag.merchantId, failures: 0, awaitingUntil: null, lockedUntil: null });
      return this.claimAndStart(to, customerId, tag.merchantId, tag.tipsEnabled, bill.id, merchant);
    }
    const failures = (await this.currentFailures(customerId, tagId)) + 1;
    await audit(db, { merchantId: tag.merchantId, actorKind: "customer", actorId: customerId, action: "bill_code.failed", entity: "tag", entityId: tagId, detail: { failures } });
    if (failures >= BILL_CODE_MAX_ATTEMPTS) {
      await setCodePrompt(db, { customerId, tagId, merchantId: tag.merchantId, failures, awaitingUntil: null, lockedUntil: new Date(now.getTime() + BILL_CODE_LOCK_MINUTES * MINUTE) });
      return this.send(to, customerId, tag.merchantId, catalogue.codeLocked({ merchant, minutes: BILL_CODE_LOCK_MINUTES }));
    }
    await setCodePrompt(db, { customerId, tagId, merchantId: tag.merchantId, failures, awaitingUntil: new Date(now.getTime() + CODE_PROMPT_MINUTES * MINUTE), lockedUntil: null });
    return this.send(to, customerId, tag.merchantId, catalogue.codeBad({ left: BILL_CODE_MAX_ATTEMPTS - failures }));
  }

  /**
   * Open amount and quick tip: the bill is created by the tap itself, addressed to and claimed
   * by this customer (so it never blocks the tag for anyone else), then the customer types or
   * picks the amount.
   */
  private async startOnTheFly(to: string, customerId: string, tag: TagContext, type: "open" | "quick_tip"): Promise<void> {
    const { db, crypto } = this.d;
    const now = this.now();
    const billId = await db.transaction().execute(async (trx) => {
      const bill = await createBill(trx, {
        merchantId: tag.merchantId,
        tagId: tag.tagId,
        assignedUserId: tag.staffUserId,
        createdBy: null,
        lines: [],
        billToken: newUrlToken(),
        expiresAt: new Date(now.getTime() + this.d.config.BILL_EXPIRY_HOURS * HOUR),
        type,
        intendedMsisdn: { hash: crypto.lookupHash(to), enc: crypto.encrypt(to) },
      });
      await transitionBill(trx, bill.id, "open", "claim", { customer_id: customerId, claimed_at: now });
      await createSession(trx, {
        merchantId: tag.merchantId,
        billId: bill.id,
        customerId,
        status: nextSession("claimed", "ask_amount"),
        base: 0,
        tip: 0,
        expiresAt: this.sessionExpiry(),
        waWindowExpiresAt: new Date(now.getTime() + 24 * HOUR),
      });
      return bill.id;
    });
    await audit(db, { merchantId: tag.merchantId, actorKind: "customer", actorId: customerId, action: `bill.${type}_started`, entity: "bill", entityId: billId });
    const s = await latestActiveSession(db, customerId);
    if (s) await this.resendPrompt(to, customerId, s);
  }

  private async startSession(
    to: string,
    customerId: string,
    merchantId: string,
    tipsEnabled: boolean,
    hold: { billId: string; shareId?: string; base: number; amountFirst?: boolean },
  ): Promise<void> {
    const now = this.now();
    await createSession(this.d.db, {
      merchantId,
      billId: hold.billId,
      shareId: hold.shareId ?? null,
      customerId,
      status: nextSession("claimed", hold.amountFirst ? "ask_amount" : tipsEnabled ? "ask_tip" : "skip_tip"),
      base: hold.base,
      tip: 0,
      expiresAt: this.sessionExpiry(),
      waWindowExpiresAt: new Date(now.getTime() + 24 * HOUR),
    });
    const s = await latestActiveSession(this.d.db, customerId);
    if (s) await this.resendPrompt(to, customerId, s);
  }

  private describe(s: ActiveSession): string {
    const what = describeLines(s.lines);
    return s.shareLabel ? `${s.shareLabel} of ${what}` : what;
  }

  /** Send whatever the session is currently waiting for. */
  private async resendPrompt(to: string, customerId: string, s: ActiveSession): Promise<void> {
    const base = cents(s.base ?? 0);
    const description = this.describe(s);
    const merchant = s.merchantName;
    const say = (msg: OutMessage) => this.send(to, customerId, s.merchantId, msg);
    switch (s.status) {
      case "awaiting_amount":
        return s.billType === "quick_tip"
          ? say(catalogue.quickTip({ merchant, staff: s.staffName, presets: s.quickTipPresets.map((c) => cents(c)) }))
          : say(catalogue.askAmount({ merchant }));
      case "awaiting_tip":
        return say(catalogue.claimFixed({ merchant, description, base, staff: s.staffName, tipPercents: offeredPresets(base, tipPolicy(s)) }));
      case "awaiting_confirm":
        return s.billType === "quick_tip"
          ? say(catalogue.confirmQuickTip({ merchant, staff: s.staffName, amount: cents(s.tip) }))
          : say(catalogue.confirm({ merchant, description, base, tip: cents(s.tip), tipsEnabled: s.tipsEnabled }));
      case "awaiting_payment": {
        const p = await pendingPaymentForSession(this.d.db, s.id);
        const url = (p?.raw as { checkoutUrl?: string } | null)?.checkoutUrl;
        return say(url ? catalogue.paymentPending({ merchant, url }) : catalogue.fallback());
      }
      case "failed":
        return say(catalogue.payFailed({ merchant }));
      default:
        return say(catalogue.fallback());
    }
  }

  /** Apply a tip choice through the merchant's tip policy (SPEC 7, packages/core/tips). */
  private async applyTip(to: string, customerId: string, s: ActiveSession, choice: TipChoice): Promise<void> {
    const base = cents(s.base ?? 0);
    const policy = tipPolicy(s);
    const r = resolveTip(base, choice, policy);
    if (r.ok) return this.chooseTip(to, customerId, s, r.tip);
    // A forged or stale preset: show the real choices again.
    if (r.reason === "not_offered") return this.resendPrompt(to, customerId, s);
    return this.send(to, customerId, s.merchantId, catalogue.tipCustomInvalid({ min: cents(policy.minCents), max: tipCap(base, policy), maxPercent: policy.maxBp / 100 }));
  }

  /** Typed tip after "Other amount": "12%" is a percentage of the bill, a bare number is rands. */
  private async onCustomTip(to: string, customerId: string, s: ActiveSession, text: string): Promise<void> {
    const choice = parseTipText(text);
    // Unparseable text gets the same "between min and max" reply as an out-of-range amount.
    if (!choice) return this.applyTip(to, customerId, s, { kind: "amount", cents: 0 });
    return this.applyTip(to, customerId, s, choice);
  }

  /** Typed amount: an open bill's amount, or a quick tip's "Other" amount. */
  private async onAmountText(to: string, customerId: string, s: ActiveSession, text: string): Promise<void> {
    const amount = parseRands(text);
    if (s.billType === "quick_tip") {
      const min = cents(s.quickTipMin);
      const max = cents(s.quickTipMax);
      if (amount === null || amount < min || amount > max) return this.send(to, customerId, s.merchantId, catalogue.quickTipInvalid({ min, max }));
      return this.setQuickTip(to, customerId, s, amount);
    }
    const max = cents(s.openAmountMax);
    if (amount === null || amount < MIN_OPEN_AMOUNT || amount > max || !s.billId) {
      return this.send(to, customerId, s.merchantId, catalogue.amountInvalid({ max }));
    }
    const { db } = this.d;
    const lines: BillLine[] = [{ description: "Amount", amountCents: amount }];
    if (!(await setBillLines(db, s.merchantId, s.billId, lines))) return this.resendPrompt(to, customerId, s);
    const moved = await transitionSession(db, s.id, "awaiting_amount", s.tipsEnabled ? "ask_tip" : "skip_tip", { base_cents: amount, tip_cents: 0 });
    if (!moved) return;
    const fresh = await latestActiveSession(db, customerId);
    if (fresh) return this.resendPrompt(to, customerId, fresh);
  }

  private async setQuickTip(to: string, customerId: string, s: ActiveSession, amount: Cents): Promise<void> {
    // A quick tip is all tip: no bill amount, 100% to the tagged person (SPEC 3).
    const moved = await transitionSession(this.d.db, s.id, "awaiting_amount", "skip_tip", { base_cents: 0, tip_cents: amount });
    if (!moved) return;
    return this.send(to, customerId, s.merchantId, catalogue.confirmQuickTip({ merchant: s.merchantName, staff: s.staffName, amount }));
  }

  private async chooseTip(to: string, customerId: string, s: ActiveSession, tip: Cents): Promise<void> {
    const ok = await transitionSession(this.d.db, s.id, "awaiting_tip", "choose_tip", { tip_cents: tip });
    if (!ok) return; // a concurrent reply already moved this session on
    return this.send(
      to,
      customerId,
      s.merchantId,
      catalogue.confirm({ merchant: s.merchantName, description: this.describe(s), base: cents(s.base ?? 0), tip, tipsEnabled: s.tipsEnabled }),
    );
  }

  private async onReply(to: string, customerId: string, s: ActiveSession, id: string): Promise<void> {
    const { db } = this.d;
    const merchant = s.merchantName;

    const tipChoice = parseTipId(id);
    if (tipChoice && s.status === "awaiting_tip") {
      if (tipChoice.kind === "custom") return this.send(to, customerId, s.merchantId, catalogue.tipCustomAsk());
      if (tipChoice.kind === "none") return this.applyTip(to, customerId, s, { kind: "none" });
      // Presets are whole percents; resolveTip refuses any that is not on offer for this bill.
      if (tipChoice.bp % 100 !== 0) return this.resendPrompt(to, customerId, s);
      return this.applyTip(to, customerId, s, { kind: "preset", percent: tipChoice.bp / 100 });
    }

    const qt = parseQuickTipId(id);
    if (qt !== null && s.status === "awaiting_amount" && s.billType === "quick_tip") {
      if (qt === "other") return this.send(to, customerId, s.merchantId, catalogue.quickTipAsk({ min: cents(s.quickTipMin), max: cents(s.quickTipMax) }));
      if (!s.quickTipPresets.includes(qt)) return this.resendPrompt(to, customerId, s);
      return this.setQuickTip(to, customerId, s, cents(qt));
    }

    // Change tip only where a tip step exists: a quick tip changes its amount instead, and a
    // merchant with tips off never offers it (a stale or forged reply just re-shows the step).
    if (id === IDS.changeTip && s.status === "awaiting_confirm" && (s.tipsEnabled || s.billType === "quick_tip")) {
      const event = s.billType === "quick_tip" ? "change_amount" : "change_tip";
      if (await transitionSession(db, s.id, "awaiting_confirm", event, { tip_cents: 0 })) {
        const fresh = await latestActiveSession(db, customerId);
        if (fresh) return this.resendPrompt(to, customerId, fresh);
      }
      return;
    }

    if (id === IDS.payNow && s.status === "awaiting_confirm") return this.onPayNow(to, customerId, s);

    if (id === IDS.cancel && canSession(s.status, "cancel")) {
      if (await transitionSession(db, s.id, s.status, "cancel")) {
        await this.releaseHold(s, customerId);
        return this.send(to, customerId, s.merchantId, catalogue.cancelled({ merchant }));
      }
      return;
    }
    if (id === IDS.cancel && s.status === "failed") {
      await this.releaseHold(s, customerId);
      return this.send(to, customerId, s.merchantId, catalogue.cancelled({ merchant }));
    }

    if (id === IDS.tryAgain && s.status === "failed" && s.billId) {
      // SPEC 6.2: a retry is a new session on the same bill (or share) with a new reference.
      const status: SessionState = nextSession(nextSession("claimed", "ask_tip"), "choose_tip");
      await createSession(db, {
        merchantId: s.merchantId,
        billId: s.billId,
        shareId: s.shareId,
        customerId,
        status,
        base: s.base ?? 0,
        tip: s.tip,
        expiresAt: this.sessionExpiry(),
        waWindowExpiresAt: new Date(this.now().getTime() + 24 * HOUR),
      });
      const fresh = await latestActiveSession(db, customerId);
      if (fresh) return this.resendPrompt(to, customerId, fresh);
      return;
    }

    // A stale or unexpected button: repeat the current step instead of guessing.
    return this.resendPrompt(to, customerId, s);
  }

  /** Still holding the bill or share at the amount the customer confirmed (SPEC 5)? */
  private async stillHeld(s: ActiveSession, customerId: string): Promise<boolean> {
    const { db } = this.d;
    if (s.shareId) {
      const share = await getShare(db, s.shareId);
      return share?.status === "claimed" && share.customer_id === customerId && share.amount_cents === s.base;
    }
    const bill = s.billId ? await getBill(db, s.merchantId, s.billId) : undefined;
    return bill?.status === "claimed" && bill.customer_id === customerId && bill.subtotal_cents === s.base;
  }

  private async onPayNow(to: string, customerId: string, s: ActiveSession): Promise<void> {
    const { db, provider, config } = this.d;
    if (!(await this.stillHeld(s, customerId))) {
      await transitionSession(db, s.id, "awaiting_confirm", "cancel");
      return this.send(to, customerId, s.merchantId, catalogue.sessionExpired());
    }
    const total = cents((s.base ?? 0) + s.tip);
    if (total <= 0) return this.send(to, customerId, s.merchantId, catalogue.fallback());

    const checkout = await provider.createCheckout({
      reference: s.id,
      amount: total,
      description: `${s.merchantName}: ${s.billType === "quick_tip" ? "Tip" : this.describe(s)}`.slice(0, 120),
      returnUrl: `${config.PUBLIC_API_URL}/pay/return`,
      webhookUrl: `${config.PUBLIC_API_URL}/webhooks/provider/${provider.name}`,
      idempotencyKey: `${s.id}:v${s.version}`,
    });

    const moved = await db.transaction().execute(async (trx) => {
      const expiresAt = new Date(Math.max(s.expiresAt.getTime(), checkout.expiresAt.getTime()));
      if (!(await transitionSession(trx, s.id, "awaiting_confirm", "pay_now", { expires_at: expiresAt }))) return false;
      await insertPendingPayment(trx, {
        merchantId: s.merchantId,
        sessionId: s.id,
        provider: provider.name,
        providerRef: checkout.providerRef,
        idempotencyKey: `${s.id}:v${s.version}`,
        amount: total,
        checkoutUrl: checkout.url,
        checkoutExpiresAt: checkout.expiresAt,
      });
      return true;
    });
    if (!moved) return; // a duplicate Pay now: the first one sends the link

    const minutes = Math.max(1, Math.round((checkout.expiresAt.getTime() - this.now().getTime()) / MINUTE));
    return this.send(to, customerId, s.merchantId, catalogue.payLink({ merchant: s.merchantName, total, url: checkout.url, minutes }));
  }

  // ── Provider events ────────────────────────────────────────────────────────

  /**
   * Apply a verified provider event (SPEC backend step 8). The caller has already verified the
   * signature and de-duplicated by event id; this is additionally idempotent on the payment row.
   * Returns a short outcome code for the webhook_events row (never PII).
   */
  async handleProviderEvent(ev: VerifiedEvent): Promise<{ status: "processed" | "ignored" | "failed"; error?: string }> {
    const { db, provider, config } = this.d;
    const now = this.now();
    const flag = (trx: Kysely<Database>, merchantId: string, paymentId: string, action: string, detail: Record<string, unknown> = {}) =>
      audit(trx, { merchantId, actorKind: "system", actorId: null, action, entity: "payment", entityId: paymentId, detail });

    if (ev.type === "refund.succeeded" || ev.type === "chargeback") return this.moneyEvent(ev);

    const result = await db.transaction().execute(async (trx) => {
      const p = await lockPaymentByProviderRef(trx, provider.name, ev.providerRef);
      if (!p) return { kind: "error" as const, error: "unknown_payment" };
      if (ev.reference !== p.sessionId || ev.currency !== "ZAR") {
        await flag(trx, p.merchantId, p.id, "payment.reference_mismatch");
        return { kind: "error" as const, error: "reference_mismatch" };
      }

      if (ev.type === "payment.succeeded") {
        if (p.status === "succeeded") return { kind: "duplicate" as const };
        // Never mark paid on a different amount (SPEC edge case "amount mismatch").
        if (ev.amount !== p.amount) {
          await flag(trx, p.merchantId, p.id, "payment.amount_mismatch", { expected: p.amount, received: ev.amount });
          return { kind: "error" as const, error: "amount_mismatch" };
        }
        if (!(await settlePayment(trx, p.id, { status: "succeeded", method: ev.method ?? null, fee: ev.feeCents ?? null }))) {
          return { kind: "duplicate" as const };
        }
        if (canSession(p.sessionStatus, "payment_succeeded")) {
          await transitionSession(trx, p.sessionId, p.sessionStatus, "payment_succeeded");
        }
        const bill = p.billId ? await getBill(trx, p.merchantId, p.billId) : undefined;
        let settled = false;
        if (p.shareId) {
          // A share is paid; the bill is paid when the last share is (SPEC 5 groups).
          const share = await getShare(trx, p.shareId);
          if (share && share.amount_cents === p.base && canShare(share.status, "pay")) {
            settled = await transitionShare(trx, share.id, share.status, "pay");
            if (settled && bill && (await unpaidShareCount(trx, bill.id)) === 0 && canBill(bill.status, "pay")) {
              await transitionBill(trx, bill.id, bill.status, "pay", { paid_at: now });
            }
          }
        } else if (bill && bill.subtotal_cents === p.base && canBill(bill.status, "pay")) {
          // Only settle the bill at the amount it now has: a checkout opened before a merchant
          // edit pays a stale amount (SPEC 5 rule 4) and is flagged below instead.
          settled = await transitionBill(trx, bill.id, bill.status, "pay", { paid_at: now, customer_id: p.customerId });
        }
        if (!settled) {
          // Money was taken but the bill or share was already settled, closed or re-priced (a
          // double payment or a stale amount). Refunds are M5; flag it loudly now.
          await flag(trx, p.merchantId, p.id, "payment.needs_refund", { billStatus: bill?.status ?? null });
        }
        const base = cents(p.base ?? 0);
        const tip = cents(p.tip);
        // The split by the merchant's rules (SPEC 8): sale shares, tip rule, fee allocation.
        const postings = await postPayment(trx, {
          merchantId: p.merchantId,
          paymentId: p.id,
          base,
          tip,
          providerFee: ev.feeCents ?? 0,
          servingStaffUserId: bill?.assigned_user_id ?? null,
          lines: bill?.lines ?? null,
          now,
        });
        const token = newUrlToken();
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(now).replaceAll("-", "");
        await createReceipt(trx, { merchantId: p.merchantId, paymentId: p.id, token, number: `R-${day}-${p.id.slice(0, 6).toUpperCase()}` });
        await flag(trx, p.merchantId, p.id, "payment.succeeded");
        return {
          kind: "paid" as const,
          paymentId: p.id,
          merchantId: p.merchantId,
          customerId: p.customerId,
          total: cents(p.amount),
          receiptToken: token,
          alert: {
            merchantId: p.merchantId,
            billId: p.billId,
            paymentId: p.id,
            staffUserId: bill?.assigned_user_id ?? null,
            createdBy: bill?.created_by ?? null,
            customerId: p.customerId,
            description: bill?.type === "quick_tip" ? "Tip" : describeLines(bill?.lines),
            base,
            tip,
            total: p.amount,
            shares: staffShares(postings),
          },
        };
      }

      // Failure or cancellation of the checkout.
      if (!(await settlePayment(trx, p.id, { status: ev.type === "payment.cancelled" ? "cancelled" : "failed", method: null, fee: null }))) {
        return { kind: "duplicate" as const };
      }
      if (p.sessionStatus === "awaiting_payment") await transitionSession(trx, p.sessionId, "awaiting_payment", "payment_failed");
      await flag(trx, p.merchantId, p.id, "payment.failed");
      const bill = p.billId ? await getBill(trx, p.merchantId, p.billId) : undefined;
      return {
        kind: "failed" as const,
        merchantId: p.merchantId,
        customerId: p.customerId,
        alert: {
          merchantId: p.merchantId,
          billId: p.billId,
          paymentId: p.id,
          staffUserId: bill?.assigned_user_id ?? null,
          createdBy: bill?.created_by ?? null,
          customerId: p.customerId,
          description: bill?.type === "quick_tip" ? "Tip" : describeLines(bill?.lines),
          base: p.base ?? 0,
          tip: p.tip,
          total: p.amount,
          shares: new Map<string, number>(),
        },
      };
    });

    if (result.kind === "error") {
      this.d.log.warn({ provider: provider.name, error: result.error }, "provider event not applied");
      return { status: "failed", error: result.error };
    }
    if (result.kind === "duplicate") return { status: "ignored" };

    // After commit: tell the merchant (PWA, push, WhatsApp) and the customer. A send failure
    // never undoes the payment.
    const alert = result.alert;
    await this.notify((e) => (result.kind === "paid" ? e.paymentSucceeded(alert) : e.paymentFailed(alert)));
    const to = await customerMsisdn(db, this.d.crypto, result.customerId);
    const merchant = (await db.selectFrom("merchants").select("name").where("id", "=", result.merchantId).executeTakeFirst())?.name ?? "";
    if (to) {
      if (result.kind === "paid") {
        const receiptUrl = `${config.PUBLIC_API_URL}/r/${result.receiptToken}`;
        await this.send(to, result.customerId, result.merchantId, catalogue.paySuccess({ merchant, total: result.total, receiptUrl, slipUrl: `${receiptUrl}/slip.png` }));
      } else {
        await this.send(to, result.customerId, result.merchantId, catalogue.payFailed({ merchant }));
      }
    }
    return { status: "processed" };
  }

  /** Refund confirmations and chargebacks from the provider (SPEC 10). */
  private async moneyEvent(ev: VerifiedEvent): Promise<{ status: "processed" | "ignored" | "failed"; error?: string }> {
    const { db, provider, money } = this.d;
    if (!money) return { status: "failed", error: "money_disabled" };
    const p = await db.selectFrom("payments").select(["id", "merchant_id", "session_id"]).where("provider", "=", provider.name).where("provider_ref", "=", ev.providerRef).executeTakeFirst();
    if (!p || ev.reference !== p.session_id) return { status: "failed", error: "unknown_payment" };
    if (ev.type === "chargeback") {
      await money.chargeback({ merchantId: p.merchant_id, paymentId: p.id, providerEventId: ev.eventId });
      return { status: "processed" };
    }
    const pending = await db.selectFrom("refunds").select("id").where("payment_id", "=", p.id).where("status", "=", "pending").orderBy("created_at").execute();
    if (pending.length === 0) return { status: "ignored" };
    for (const r of pending) await money.settleRefund(r.id);
    return { status: "processed" };
  }

  /** Look up the receipt for a payment (used to resend a slip). */
  async receiptFor(paymentId: string) {
    return receiptByPayment(this.d.db, paymentId);
  }

  // ── Merchant actions (M4 exposes these over the authenticated merchant API) ──

  /**
   * Create a bill for any mode (SPEC 3). Bills addressed to a number get a 4-digit code so a
   * different phone can still claim them on the tag. Returns the bill, its code and its link.
   */
  async createBill(i: NewBillInput) {
    const { db, crypto, config } = this.d;
    if (i.lines.length === 0 || i.lines.some((l) => !Number.isSafeInteger(l.amountCents) || l.amountCents <= 0)) {
      throw new FlowError("bad_lines", "a bill needs at least one line with a positive amount");
    }
    let tagId: string | null = null;
    let assigned = i.assignedUserId ?? null;
    if (i.tagCode) {
      const tag = await findTagForTap(db, { code: i.tagCode });
      if (!tag || tag.merchantId !== i.merchantId) throw new FlowError("unknown_tag", "tag not found for this merchant");
      if (tag.tagStatus !== "active") throw new FlowError("tag_inactive", "tag is not active");
      tagId = tag.tagId;
      assigned ??= tag.staffUserId;
    }
    const total = linesTotal(i.lines);
    const shares = !i.shares
      ? undefined
      : "equal" in i.shares
        ? equalShares(total, i.shares.equal).map((amountCents, k, all) => ({ label: `Share ${k + 1} of ${all.length}`, amountCents }))
        : i.shares.amounts;
    const msisdn = i.customerMsisdn ?? null;
    const bill = await db.transaction().execute((trx) =>
      createBill(trx, {
        merchantId: i.merchantId,
        tagId,
        assignedUserId: assigned,
        createdBy: i.createdBy,
        lines: i.lines,
        billToken: newUrlToken(),
        expiresAt: new Date(this.now().getTime() + config.BILL_EXPIRY_HOURS * HOUR),
        intendedMsisdn: msisdn ? { hash: crypto.lookupHash(msisdn), enc: crypto.encrypt(msisdn) } : null,
        billCode: msisdn ? String(randomInt(10_000)).padStart(4, "0") : null,
        tableLabel: i.tableLabel ?? null,
        ...(shares ? { shares } : {}),
      }),
    );
    await audit(db, { merchantId: i.merchantId, actorKind: "user", actorId: i.createdBy, action: "bill.created", entity: "bill", entityId: bill.id });
    await this.billEvent(i.merchantId, bill.id, "bill.created");
    return { bill, billCode: bill.bill_code, link: `${config.PUBLIC_API_URL}/b/${bill.bill_token}` };
  }

  /** Release a wrongly claimed bill (SPEC 5 rule 3): the claimer's session is cancelled. */
  async releaseBill(merchantId: string, billId: string, actorUserId: string | null): Promise<void> {
    const { db } = this.d;
    const bill = await getBill(db, merchantId, billId);
    if (!bill) throw new FlowError("not_found", "bill not found");
    const touched = await this.cancelSessions(merchantId, billId, catalogue.billReleased);
    if (bill.status === "claimed") await transitionBill(db, billId, "claimed", "release", { customer_id: null, claimed_at: null });
    await audit(db, { merchantId, actorKind: "user", actorId: actorUserId, action: "bill.released", entity: "bill", entityId: billId, detail: { sessionsCancelled: touched.length } });
    await this.billEvent(merchantId, billId, "bill.released");
  }

  /**
   * Edit the amount after a claim (SPEC 5 rule 4): cancel the old session so nobody pays a stale
   * amount, keep the customer's claim, and start a new session at the new amount.
   */
  async editBillLines(merchantId: string, billId: string, lines: BillLine[], actorUserId: string | null): Promise<void> {
    const { db } = this.d;
    if (lines.length === 0 || lines.some((l) => !Number.isSafeInteger(l.amountCents) || l.amountCents <= 0)) {
      throw new FlowError("bad_lines", "a bill needs at least one line with a positive amount");
    }
    if ((await listShares(db, billId)).length > 0) throw new FlowError("has_shares", "split bills cannot be edited; cancel and create a new one");
    const before = await getBill(db, merchantId, billId);
    if (!before) throw new FlowError("not_found", "bill not found");
    if (!(await setBillLines(db, merchantId, billId, lines))) throw new FlowError("not_editable", "bill is no longer open");
    const touched = await this.cancelSessions(merchantId, billId, catalogue.amountChanged);
    await audit(db, { merchantId, actorKind: "user", actorId: actorUserId, action: "bill.edited", entity: "bill", entityId: billId, detail: { from: before.subtotal_cents, to: linesTotal(lines) } });
    await this.billEvent(merchantId, billId, "bill.updated");
    // The customer who held the bill gets the new amount straight away.
    const after = await getBill(db, merchantId, billId);
    if (after?.status === "claimed" && after.customer_id) {
      const to = await customerMsisdn(db, this.d.crypto, after.customer_id);
      const m = await db.selectFrom("merchants").select("tips_enabled").where("id", "=", merchantId).executeTakeFirstOrThrow();
      if (to && touched.some((t) => t.customerId === after.customer_id)) {
        await this.startSession(to, after.customer_id, merchantId, m.tips_enabled, { billId, base: after.subtotal_cents });
      }
    }
  }

  async cancelBill(merchantId: string, billId: string, actorUserId: string | null): Promise<void> {
    const { db } = this.d;
    const bill = await getBill(db, merchantId, billId);
    if (!bill) throw new FlowError("not_found", "bill not found");
    if (!canBill(bill.status, "cancel")) throw new FlowError("not_cancellable", `bill is ${bill.status}`);
    await this.cancelSessions(merchantId, billId, catalogue.billCancelledByMerchant);
    for (const sh of await listShares(db, billId)) {
      if (canShare(sh.status, "cancel")) await transitionShare(db, sh.id, sh.status, "cancel");
    }
    await transitionBill(db, billId, bill.status, "cancel");
    await audit(db, { merchantId, actorKind: "user", actorId: actorUserId, action: "bill.cancelled", entity: "bill", entityId: billId });
    await this.billEvent(merchantId, billId, "bill.cancelled");
  }

  /** Cancel every in-progress session on a bill and tell each customer why. */
  private async cancelSessions(merchantId: string, billId: string, notice: (i: { merchant: string }) => OutMessage) {
    const { db } = this.d;
    const sessions = await activeSessionsOnBill(db, merchantId, billId);
    const merchant = (await db.selectFrom("merchants").select("name").where("id", "=", merchantId).executeTakeFirstOrThrow()).name;
    const cancelled: typeof sessions = [];
    for (const s of sessions) {
      if (!(await transitionSession(db, s.id, s.status, "cancel"))) continue;
      cancelled.push(s);
      if (s.shareId) {
        const share = await getShare(db, s.shareId);
        if (share?.status === "claimed") await transitionShare(db, share.id, "claimed", "release", { customer_id: null, claimed_at: null });
      }
      const to = await customerMsisdn(db, this.d.crypto, s.customerId);
      if (to) await this.send(to, s.customerId, merchantId, notice({ merchant }));
    }
    return cancelled;
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  private async send(to: string, customerId: string | null, merchantId: string | null, msg: OutMessage): Promise<void> {
    const { wa, db, log } = this.d;
    try {
      const r =
        msg.kind === "text"
          ? await wa.sendText(to, msg.body)
          : msg.kind === "buttons"
            ? await wa.sendButtons(to, msg.body, msg.buttons)
            : msg.kind === "list"
              ? await wa.sendList(to, msg.body, msg.buttonLabel, msg.rows)
              : await wa.sendImage(to, msg.imageUrl, msg.caption);
      await logMessage(db, { customerId, merchantId, direction: "out", waMessageId: r.messageId, kind: msg.kind });
    } catch (e) {
      // notify.retry picks these up once notifications land (M4). Never log the number.
      log.error({ err: (e as Error).message, kind: msg.kind }, "whatsapp send failed");
      await logMessage(db, { customerId, merchantId, direction: "out", waMessageId: null, kind: `${msg.kind}:failed` });
    }
  }
}
