import type { FastifyBaseLogger } from "fastify";
import { sql } from "@tappay/db";
import {
  canSession,
  cents,
  computePostings,
  isCredit,
  partyKey,
  refundReversals,
  reversalKey,
  type Clock,
  type PaymentProvider,
  type Posting,
  type SaleShare,
  type SessionState,
  type SplitInput,
  type TipRule,
} from "@tappay/core";
import type { Config } from "@tappay/config";
import { audit, insertPostings, paymentPostings, transitionSession, type BillLine, type Crypto, type Database, type Kysely, type Transaction } from "@tappay/db";

/**
 * Money (SPEC 8 to 10): how a payment is split in the ledger, refunds that reverse the split,
 * and payouts of what staff are owed. The ledger is the single source of truth whatever the
 * split strategy; it is append-only (DB triggers).
 *
 * Split strategies (SPLIT_STRATEGY):
 *   ledger_only (default)   all money settles to the merchant; payouts are created for the
 *                           merchant to pay staff themselves, then marked paid
 *   collect_then_payout     payouts are sent through the provider's payouts API (needs legal
 *                           sign-off in production; config refuses otherwise)
 *   native                  the provider splits at settlement; needs a provider that can
 *                           (capabilities.nativeSplit); refused at start-up otherwise (M8)
 */

type Db = Kysely<Database> | Transaction<Database>;

export interface MoneyDeps {
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  provider: PaymentProvider;
  clock: Clock;
  log: FastifyBaseLogger;
  /** Staff alerts for refunds and payouts (Notifier). */
  alerts?: MoneyAlerts;
}

export interface MoneyAlerts {
  refunded(e: { merchantId: string; refundId: string; paymentId: string; amount: number; staffReversed: Map<string, number>; customerId: string }): Promise<void>;
  payoutSent(e: { merchantId: string; payoutId: string; userId: string; amount: number }): Promise<void>;
}

export class MoneyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

const sastDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(d);

// ── Split context ────────────────────────────────────────────────────────────

/**
 * The merchant's rules for one payment: per-service sale shares if that service has any,
 * otherwise the merchant default; the tip rule; the running tip-pool shift; fee policy.
 */
export async function splitContext(db: Db, merchantId: string, lines: BillLine[] | null, now: Date): Promise<Omit<SplitInput, "base" | "tip" | "providerFee" | "servingStaffUserId">> {
  const m = await db
    .selectFrom("merchants")
    .select(["tip_rule", "tip_house_cut_bp", "fee_policy", "platform_fee_bp", "platform_fee_cents"])
    .where("id", "=", merchantId)
    .executeTakeFirstOrThrow();
  const serviceId = lines?.find((l) => l.serviceId)?.serviceId ?? null;
  const rules = await db
    .selectFrom("split_rules")
    .select(["service_id", "party_kind", "party_user_id", "basis_points"])
    .where("merchant_id", "=", merchantId)
    .where("applies_to", "=", "sale")
    .where("active", "=", true)
    .execute();
  const forService = serviceId ? rules.filter((r) => r.service_id === serviceId) : [];
  const chosen = forService.length > 0 ? forService : rules.filter((r) => r.service_id === null);
  const saleShares: SaleShare[] = chosen
    .filter((r) => r.party_kind === "staff")
    .map((r) => (r.party_user_id ? { to: "staff" as const, userId: r.party_user_id, bp: r.basis_points } : { to: "servingStaff" as const, bp: r.basis_points }));

  const tipRule: TipRule = m.tip_rule === "house_cut" ? { kind: "house_cut", bp: m.tip_house_cut_bp } : { kind: m.tip_rule };
  const shift = await db
    .selectFrom("shifts")
    .select("id")
    .where("merchant_id", "=", merchantId)
    .where("tip_pool", "=", true)
    .where("starts_at", "<=", now)
    .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", now)]))
    .orderBy("starts_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const poolMembers = shift
    ? (
        await db
          .selectFrom("shift_members")
          .innerJoin("users", "users.id", "shift_members.user_id")
          .select(["shift_members.user_id", "shift_members.weight"])
          .where("shift_members.shift_id", "=", shift.id)
          .where("users.active", "=", true)
          .execute()
      ).map((r) => ({ userId: r.user_id, weight: r.weight }))
    : null;

  return { saleShares, tipRule, poolMembers, feePolicy: m.fee_policy, platformFee: { bp: m.platform_fee_bp, fixedCents: m.platform_fee_cents } };
}

/** Ledger lines for a confirmed payment, written in the caller's transaction. */
export async function postPayment(
  trx: Db,
  i: { merchantId: string; paymentId: string; base: number; tip: number; providerFee: number; servingStaffUserId: string | null; lines: BillLine[] | null; now: Date },
): Promise<Posting[]> {
  const ctx = await splitContext(trx, i.merchantId, i.lines, i.now);
  const postings = computePostings({ ...ctx, base: cents(i.base), tip: cents(i.tip), providerFee: cents(i.providerFee), servingStaffUserId: i.servingStaffUserId });
  await insertPostings(trx, i.merchantId, i.paymentId, postings);
  return postings;
}

/** Each staff member's credit from these postings (for "your share" alerts). */
export function staffShares(p: Posting[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const x of p) if (isCredit(x) && x.party.kind === "staff") out.set(x.party.userId, (out.get(x.party.userId) ?? 0) + x.amount);
  return out;
}

// ── Refunds ──────────────────────────────────────────────────────────────────

export class Money {
  constructor(private readonly d: MoneyDeps) {}

  private now(): Date {
    return this.d.clock.now();
  }

  /**
   * Refund all or part of a payment (SPEC 10). Idempotent on `idempotencyKey`. The provider
   * reverses the card payment; on success the ledger gets reversing lines in proportion to the
   * original split. Provider fees are not reversed (the provider keeps them; OPEN_QUESTIONS I25).
   */
  async refund(i: { merchantId: string; paymentId: string; amountCents?: number; reason: string; actorUserId: string | null; idempotencyKey: string }) {
    const { db, provider } = this.d;
    const key = `${i.merchantId}:refund:${i.idempotencyKey}`;
    const prior = await db.selectFrom("refunds").selectAll().where("idempotency_key", "=", key).executeTakeFirst();
    if (prior) {
      if (prior.payment_id !== i.paymentId) throw new MoneyError("idempotency_conflict", "this Idempotency-Key was used for another payment");
      return prior;
    }

    const created = await db.transaction().execute(async (trx) => {
      const p = await trx
        .selectFrom("payments")
        .select(["id", "status", "amount_cents", "refunded_cents", "provider_ref", "provider_payment_id"])
        .where("merchant_id", "=", i.merchantId)
        .where("id", "=", i.paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!p) throw new MoneyError("not_found", "payment not found", 404);
      if (p.status !== "succeeded" && p.status !== "partially_refunded") throw new MoneyError("not_refundable", `payment is ${p.status}`);
      const pending = await trx
        .selectFrom("refunds")
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_cents"), eb.lit(0)).as("n"))
        .where("payment_id", "=", p.id)
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow();
      const room = p.amount_cents - p.refunded_cents - Number(pending.n);
      const amount = i.amountCents ?? room;
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new MoneyError("bad_amount", "refund amount must be positive cents", 422);
      if (amount > room) throw new MoneyError("too_much", `at most ${room} cents can still be refunded`, 422);
      const r = await trx
        .insertInto("refunds")
        .values({ merchant_id: i.merchantId, payment_id: p.id, amount_cents: amount, reason: i.reason.slice(0, 200), provider_ref: null, idempotency_key: key, created_by: i.actorUserId, settled_at: null })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, { merchantId: i.merchantId, actorKind: i.actorUserId ? "user" : "system", actorId: i.actorUserId, action: "refund.requested", entity: "payment", entityId: p.id, detail: { amount } });
      return { refund: r, providerRef: p.provider_ref, providerPaymentId: p.provider_payment_id };
    });

    // The provider call happens outside the transaction; its own idempotency key protects retries.
    let result: { providerRefundRef: string; status: "pending" | "succeeded" | "failed" };
    try {
      result = await provider.refund({ providerRef: created.providerRef ?? "", providerPaymentId: created.providerPaymentId, amount: cents(created.refund.amount_cents), reason: i.reason, idempotencyKey: created.refund.id });
    } catch (e) {
      this.d.log.error({ err: (e as Error).message }, "provider refund call failed");
      result = { providerRefundRef: "", status: "failed" };
    }
    if (result.status === "failed") {
      await db.updateTable("refunds").set({ status: "failed", settled_at: this.now() }).where("id", "=", created.refund.id).where("status", "=", "pending").execute();
      throw new MoneyError("provider_refused", "the payment provider did not accept the refund", 502);
    }
    await db.updateTable("refunds").set({ provider_ref: result.providerRefundRef }).where("id", "=", created.refund.id).execute();
    // An asynchronous provider confirms by webhook (refund.succeeded, M8); the mock confirms now.
    if (result.status === "succeeded") await this.settleRefund(created.refund.id);
    return db.selectFrom("refunds").selectAll().where("id", "=", created.refund.id).executeTakeFirstOrThrow();
  }

  /** A chargeback notice from the provider: reverse like a full refund and flag the merchant. */
  async chargeback(i: { merchantId: string; paymentId: string; providerEventId: string }) {
    const { db } = this.d;
    const p = await db.selectFrom("payments").select(["amount_cents", "refunded_cents"]).where("id", "=", i.paymentId).executeTakeFirst();
    if (!p) return;
    const remaining = p.amount_cents - p.refunded_cents;
    if (remaining <= 0) return;
    const r = await db
      .insertInto("refunds")
      .values({ merchant_id: i.merchantId, payment_id: i.paymentId, amount_cents: remaining, reason: "chargeback", kind: "chargeback", provider_ref: i.providerEventId, idempotency_key: `${i.merchantId}:chargeback:${i.providerEventId}`, created_by: null, settled_at: null })
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!r) return;
    await audit(db, { merchantId: i.merchantId, actorKind: "system", actorId: null, action: "merchant.flagged_chargeback", entity: "payment", entityId: i.paymentId });
    await this.settleRefund(r.id);
  }

  /** Apply a confirmed refund to the payment, session and ledger. Safe to call twice. */
  async settleRefund(refundId: string): Promise<void> {
    const { db } = this.d;
    const now = this.now();
    const out = await db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom("refunds").selectAll().where("id", "=", refundId).forUpdate().executeTakeFirst();
      if (!r || r.status !== "pending") return null;
      const p = await trx
        .selectFrom("payments")
        .innerJoin("sessions", "sessions.id", "payments.session_id")
        .select(["payments.id", "payments.amount_cents", "payments.refunded_cents", "payments.session_id", "sessions.status as sessionStatus", "sessions.customer_id"])
        .where("payments.id", "=", r.payment_id)
        .forUpdate("payments")
        .executeTakeFirstOrThrow();
      const cumulative = p.refunded_cents + r.amount_cents;
      const ledger = await paymentPostings(trx, r.merchant_id, p.id);
      const already = new Map<string, number>();
      for (const x of ledger.filter((y) => y.kind === "refund" && y.reverses)) {
        const k = reversalKey(x.reverses!, x.party);
        already.set(k, (already.get(k) ?? 0) - x.amount);
      }
      const reversals = refundReversals(ledger, cumulative, already);
      await insertPostings(trx, r.merchant_id, p.id, reversals, r.id);

      const full = cumulative === p.amount_cents;
      await trx
        .updateTable("payments")
        .set({ refunded_cents: cumulative, status: full ? "refunded" : "partially_refunded", updated_at: now })
        .where("id", "=", p.id)
        .execute();
      const event = full ? "refund_full" : "refund_partial";
      if (canSession(p.sessionStatus as SessionState, event)) await transitionSession(trx, p.session_id, p.sessionStatus as SessionState, event);
      await trx.updateTable("refunds").set({ status: "succeeded", settled_at: now }).where("id", "=", r.id).execute();
      await audit(trx, { merchantId: r.merchant_id, actorKind: "system", actorId: null, action: `${r.kind}.settled`, entity: "payment", entityId: p.id, detail: { amount: r.amount_cents, cumulative } });

      const staffReversed = new Map<string, number>();
      for (const x of reversals) if (x.party.kind === "staff") staffReversed.set(x.party.userId, (staffReversed.get(x.party.userId) ?? 0) - x.amount);
      return { merchantId: r.merchant_id, paymentId: p.id, amount: r.amount_cents, staffReversed, customerId: p.customer_id };
    });
    if (out && this.d.alerts) {
      try {
        await this.d.alerts.refunded({ ...out, refundId });
      } catch (e) {
        this.d.log.error({ err: (e as Error).message }, "refund alert failed");
      }
    }
  }

  // ── Balances and payouts ─────────────────────────────────────────────────

  /** Ledger balance per party: earned (credits), reversed (refunds), fees, paid out, balance. */
  async balances(merchantId: string, onlyUserId: string | null = null) {
    const { db } = this.d;
    let q = db
      .selectFrom("ledger_entries")
      .leftJoin("users", "users.id", "ledger_entries.party_user_id")
      .select([
        "ledger_entries.party_kind",
        "ledger_entries.party_user_id",
        "users.display_name",
        sql<number>`coalesce(sum(case when kind in ('sale','tip') then amount_cents end), 0)`.as("earned"),
        sql<number>`coalesce(sum(case when kind = 'tip' then amount_cents end), 0)`.as("tips"),
        sql<number>`coalesce(sum(case when kind = 'refund' then amount_cents end), 0)`.as("refunded"),
        sql<number>`coalesce(sum(case when kind in ('fee','platform_fee') then amount_cents end), 0)`.as("fees"),
        sql<number>`coalesce(sum(case when kind = 'payout' then amount_cents end), 0)`.as("paid_out"),
        sql<number>`coalesce(sum(case when kind = 'adjustment' then amount_cents end), 0)`.as("adjustments"),
        sql<number>`coalesce(sum(amount_cents), 0)`.as("balance"),
      ])
      .where("ledger_entries.merchant_id", "=", merchantId)
      .groupBy(["ledger_entries.party_kind", "ledger_entries.party_user_id", "users.display_name"]);
    if (onlyUserId) q = q.where("ledger_entries.party_user_id", "=", onlyUserId);
    const rows = await q.execute();
    return rows.map((r) => ({
      partyKind: r.party_kind,
      userId: r.party_user_id,
      name: r.party_kind === "staff" ? r.display_name : r.party_kind === "pool" ? "Tip pool (no shift)" : "Business",
      earnedCents: Number(r.earned),
      tipCents: Number(r.tips),
      refundedCents: Number(r.refunded),
      feeCents: Number(r.fees),
      paidOutCents: Number(r.paid_out),
      adjustmentCents: Number(r.adjustments),
      balanceCents: Number(r.balance),
    }));
  }

  /**
   * Daily payout run (SPEC 9): every staff member whose balance is at least the merchant's
   * threshold gets one payout per day (idempotent on merchant, person and SAST date). A
   * negative or small balance carries forward; a payout is never negative.
   */
  async runPayouts(merchantId: string, actorUserId: string | null = null): Promise<{ created: number; sent: number; failed: number }> {
    const { db, config } = this.d;
    if (config.SPLIT_STRATEGY === "native") return { created: 0, sent: 0, failed: 0 }; // the provider pays at settlement
    const now = this.now();
    const m = await db.selectFrom("merchants").select(["payout_threshold_cents", "name"]).where("id", "=", merchantId).executeTakeFirstOrThrow();
    const minimum = Math.max(1, m.payout_threshold_cents);
    const owed = (await this.balances(merchantId)).filter((b) => b.partyKind === "staff" && b.userId && b.balanceCents >= minimum);
    let created = 0;
    let sent = 0;
    let failed = 0;
    for (const b of owed) {
      const payout = await db.transaction().execute(async (trx) => {
        // Re-read the balance under a per-person advisory lock so two runs cannot both pay it.
        await sql`select pg_advisory_xact_lock(hashtext(${`payout:${merchantId}:${b.userId}`}))`.execute(trx);
        const bal = await trx
          .selectFrom("ledger_entries")
          .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_cents"), eb.lit(0)).as("n"))
          .where("merchant_id", "=", merchantId)
          .where("party_kind", "=", "staff")
          .where("party_user_id", "=", b.userId!)
          .executeTakeFirstOrThrow();
        const amount = Number(bal.n);
        if (amount < minimum) return null;
        const row = await trx
          .insertInto("payouts")
          .values({
            merchant_id: merchantId,
            party_user_id: b.userId,
            amount_cents: amount,
            provider_ref: null,
            idempotency_key: `payout:${merchantId}:${b.userId}:${sastDay(now)}`,
            method: config.SPLIT_STRATEGY === "collect_then_payout" ? "provider" : "manual",
            failure_reason: null,
            created_by: actorUserId,
            settled_at: null,
          })
          .onConflict((oc) => oc.column("idempotency_key").doNothing())
          .returningAll()
          .executeTakeFirst();
        if (!row) return null;
        await trx
          .insertInto("ledger_entries")
          .values({ merchant_id: merchantId, payment_id: null, payout_id: row.id, kind: "payout", party_kind: "staff", party_user_id: b.userId, amount_cents: -amount, note: null, refund_id: null, reverses: null })
          .execute();
        await audit(trx, { merchantId, actorKind: actorUserId ? "user" : "system", actorId: actorUserId, action: "payout.created", entity: "payout", entityId: row.id, detail: { amount } });
        return row;
      });
      if (!payout) continue;
      created++;
      if (payout.method === "provider") {
        if (await this.sendViaProvider(payout.id)) sent++;
        else failed++;
      }
    }
    return { created, sent, failed };
  }

  /** The scheduled run (payout.run, 06:00 SAST): every active merchant; one failure does not stop the rest. */
  async runAllPayouts(): Promise<{ merchants: number; created: number; sent: number; failed: number }> {
    const ids = await this.d.db.selectFrom("merchants").select("id").where("status", "=", "active").execute();
    const total = { merchants: ids.length, created: 0, sent: 0, failed: 0 };
    for (const { id } of ids) {
      try {
        const r = await this.runPayouts(id);
        total.created += r.created;
        total.sent += r.sent;
        total.failed += r.failed;
      } catch (e) {
        this.d.log.error({ merchantId: id, err: (e as Error).message }, "payout run failed for merchant");
      }
    }
    return total;
  }

  private async sendViaProvider(payoutId: string): Promise<boolean> {
    const { db, provider, crypto } = this.d;
    const p = await db
      .selectFrom("payouts")
      .innerJoin("users", "users.id", "payouts.party_user_id")
      .select(["payouts.id", "payouts.merchant_id", "payouts.party_user_id", "payouts.amount_cents", "users.payout_dest_enc"])
      .where("payouts.id", "=", payoutId)
      .executeTakeFirstOrThrow();
    let outcome: { ok: boolean; ref: string | null; reason: string | null };
    if (!provider.createPayout) outcome = { ok: false, ref: null, reason: "provider_has_no_payouts" };
    else if (!p.payout_dest_enc) outcome = { ok: false, ref: null, reason: "no_payout_destination" };
    else {
      try {
        const r = await provider.createPayout({ to: { ref: crypto.decrypt(p.payout_dest_enc) }, amount: cents(p.amount_cents), reference: p.id, idempotencyKey: p.id });
        outcome = { ok: r.status !== "failed", ref: r.providerRef, reason: r.status === "failed" ? "provider_failed" : null };
      } catch (e) {
        outcome = { ok: false, ref: null, reason: (e as Error).name };
      }
    }
    if (outcome.ok) {
      await this.markSent(p.id, outcome.ref, null);
      return true;
    }
    await this.fail(p.id, outcome.reason ?? "failed");
    return false;
  }

  /** Failed payout: the money goes back on the person's balance (SPEC edge case) and the operator is alerted. */
  private async fail(payoutId: string, reason: string): Promise<void> {
    const { db } = this.d;
    await db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom("payouts").selectAll().where("id", "=", payoutId).forUpdate().executeTakeFirstOrThrow();
      if (p.status !== "pending") return;
      await trx.updateTable("payouts").set({ status: "failed", failure_reason: reason, settled_at: this.now() }).where("id", "=", p.id).execute();
      await trx
        .insertInto("ledger_entries")
        .values({ merchant_id: p.merchant_id, payment_id: null, payout_id: p.id, kind: "adjustment", party_kind: "staff", party_user_id: p.party_user_id, amount_cents: p.amount_cents, note: `payout failed: ${reason}`, refund_id: null, reverses: null })
        .execute();
      await audit(trx, { merchantId: p.merchant_id, actorKind: "system", actorId: null, action: "payout.failed", entity: "payout", entityId: p.id, detail: { reason } });
    });
    this.d.log.error({ payoutId, reason }, "payout failed: operator attention needed");
  }

  /** Mark a payout paid (a manager after paying by EFT, or the provider confirming). */
  async markSent(payoutId: string, providerRef: string | null, actorUserId: string | null, merchantId?: string): Promise<boolean> {
    const { db } = this.d;
    const moved = await db.transaction().execute(async (trx) => {
      let q = trx.updateTable("payouts").set({ status: "sent", provider_ref: providerRef, settled_at: this.now() }).where("id", "=", payoutId).where("status", "=", "pending");
      if (merchantId) q = q.where("merchant_id", "=", merchantId);
      const r = await q.returning(["merchant_id", "party_user_id", "amount_cents"]).executeTakeFirst();
      if (!r) return null;
      await audit(trx, { merchantId: r.merchant_id, actorKind: actorUserId ? "user" : "system", actorId: actorUserId, action: "payout.sent", entity: "payout", entityId: payoutId });
      return r;
    });
    if (!moved) return false;
    if (this.d.alerts && moved.party_user_id) {
      try {
        await this.d.alerts.payoutSent({ merchantId: moved.merchant_id, payoutId, userId: moved.party_user_id, amount: moved.amount_cents });
      } catch (e) {
        this.d.log.error({ err: (e as Error).message }, "payout alert failed");
      }
    }
    return true;
  }
}

export { partyKey };
