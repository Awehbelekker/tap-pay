import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Clock } from "@tappay/core";
import type { Config } from "@tappay/config";
import { audit, maskMsisdn, type Crypto, type Database, type Kysely } from "@tappay/db";
import { requireStaff, type Auth, type Staff } from "./auth.js";
import { MoneyError, type Money } from "./money.js";

/**
 * Money endpoints (api/openapi.yaml): payments with refunds, balances, payouts, split rules,
 * merchant money settings and tip-pool shifts. Refunds, rules, settings, shifts and payouts are
 * manager actions; staff see their own payments and balance. Tenant scope on every query.
 */

export interface MoneyApiDeps {
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  auth: Auth;
  money: Money;
  clock: Clock;
}

const uuid = z.string().uuid();
const isManager = (s: Staff) => s.role === "manager" || s.role === "owner";

function bad(reply: FastifyReply, err: z.ZodError) {
  return reply.code(422).send({ code: "invalid", message: "check the fields", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}
function moneyError(reply: FastifyReply, e: unknown) {
  if (e instanceof MoneyError) return reply.code(e.status).send({ code: e.code, message: e.message });
  throw e;
}

export function registerMoneyApi(app: FastifyInstance, d: MoneyApiDeps): void {
  const { db, money, crypto } = d;
  const staff = requireStaff(d.auth);
  const manager = requireStaff(d.auth, ["owner", "manager"]);
  const me = (req: FastifyRequest) => req.staff!;

  // ── Payments and refunds ───────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>("/v1/merchant/payments", { preHandler: staff }, async (req) => {
    const s = me(req);
    let q = db
      .selectFrom("payments")
      .innerJoin("sessions", "sessions.id", "payments.session_id")
      .leftJoin("bills", "bills.id", "sessions.bill_id")
      .leftJoin("customers", "customers.id", "sessions.customer_id")
      .leftJoin("receipts", (j) => j.onRef("receipts.payment_id", "=", "payments.id").on("receipts.revoked_at", "is", null))
      .select([
        "payments.id",
        "payments.amount_cents",
        "payments.refunded_cents",
        "payments.status",
        "payments.method",
        "payments.provider_fee_cents",
        "payments.paid_at",
        "sessions.base_cents",
        "sessions.tip_cents",
        "bills.id as bill_id",
        "bills.lines",
        "bills.type",
        "customers.msisdn_enc",
        "receipts.receipt_token",
      ])
      .where("payments.merchant_id", "=", s.merchantId)
      .where("payments.status", "in", ["succeeded", "partially_refunded", "refunded"]);
    if (!isManager(s)) {
      const uid = s.userId;
      q = q.where((eb) => eb.or([eb("bills.created_by", "=", uid), eb("bills.assigned_user_id", "=", uid)]));
    }
    const rows = await q.orderBy("payments.paid_at", "desc").limit(Math.min(Number(req.query.limit ?? 50) || 50, 200)).execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        billId: r.bill_id,
        description: r.type === "quick_tip" ? "Quick tip" : (r.lines ?? []).map((l) => l.description).join(", ") || "Amount",
        amountCents: r.amount_cents,
        baseCents: r.base_cents ?? 0,
        tipCents: r.tip_cents,
        refundedCents: r.refunded_cents,
        providerFeeCents: r.provider_fee_cents,
        status: r.status,
        method: r.method,
        paidAt: r.paid_at,
        maskedCustomer: r.msisdn_enc ? maskMsisdn(crypto.decrypt(r.msisdn_enc)) : null,
        receiptUrl: r.receipt_token ? `${d.config.PUBLIC_API_URL}/r/${r.receipt_token}` : null,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/v1/merchant/payments/:id/refund", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ code: "not_found", message: "payment not found" });
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 100) return reply.code(400).send({ code: "idempotency_key_required", message: "send an Idempotency-Key header" });
    const b = z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().trim().min(3).max(200) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    try {
      const r = await money.refund({ merchantId: s.merchantId, paymentId: req.params.id, ...(b.data.amountCents ? { amountCents: b.data.amountCents } : {}), reason: b.data.reason, actorUserId: s.userId, idempotencyKey: key });
      return reply.code(r.status === "succeeded" ? 200 : 202).send({ id: r.id, amountCents: r.amount_cents, status: r.status });
    } catch (e) {
      return moneyError(reply, e);
    }
  });

  // ── Balances and payouts ───────────────────────────────────────────────────

  app.get("/v1/merchant/balances", { preHandler: staff }, async (req) => {
    const s = me(req);
    const all = await money.balances(s.merchantId, isManager(s) ? null : s.userId);
    return { items: all };
  });

  app.get("/v1/merchant/payouts", { preHandler: staff }, async (req) => {
    const s = me(req);
    let q = db
      .selectFrom("payouts")
      .leftJoin("users", "users.id", "payouts.party_user_id")
      .select(["payouts.id", "payouts.party_user_id", "users.display_name", "payouts.amount_cents", "payouts.status", "payouts.method", "payouts.failure_reason", "payouts.created_at", "payouts.settled_at"])
      .where("payouts.merchant_id", "=", s.merchantId);
    if (!isManager(s)) q = q.where("payouts.party_user_id", "=", s.userId);
    const rows = await q.orderBy("payouts.created_at", "desc").limit(100).execute();
    return {
      items: rows.map((r) => ({ id: r.id, userId: r.party_user_id, name: r.display_name, amountCents: r.amount_cents, status: r.status, method: r.method, failureReason: r.failure_reason, createdAt: r.created_at, settledAt: r.settled_at })),
    };
  });

  /** Run today's payouts now (the worker does this daily at 06:00 SAST). Idempotent per day. */
  app.post("/v1/merchant/payouts/run", { preHandler: manager }, async (req) => {
    const s = me(req);
    return money.runPayouts(s.merchantId, s.userId);
  });

  /** ledger_only: the manager paid the staff member (EFT, cash) and records it. */
  app.post<{ Params: { id: string } }>("/v1/merchant/payouts/:id/mark-paid", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ code: "not_found", message: "payout not found" });
    const ok = await money.markSent(req.params.id, null, s.userId, s.merchantId);
    if (!ok) {
      const exists = await db.selectFrom("payouts").select("status").where("merchant_id", "=", s.merchantId).where("id", "=", req.params.id).executeTakeFirst();
      return exists ? reply.code(409).send({ code: "not_pending", message: `payout is ${exists.status}` }) : reply.code(404).send({ code: "not_found", message: "payout not found" });
    }
    return reply.send({ ok: true });
  });

  /**
   * Where a staff member's payouts go (collect_then_payout): the provider's recipient reference,
   * stored encrypted and never returned.
   */
  app.put<{ Params: { id: string } }>("/v1/merchant/staff/:id/payout-destination", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ code: "not_found", message: "staff member not found" });
    const b = z.object({ ref: z.string().trim().min(3).max(200) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const r = await db.updateTable("users").set({ payout_dest_enc: crypto.encrypt(b.data.ref) }).where("merchant_id", "=", s.merchantId).where("id", "=", req.params.id).executeTakeFirst();
    if (r.numUpdatedRows !== 1n) return reply.code(404).send({ code: "not_found", message: "staff member not found" });
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "staff.payout_destination_set", entity: "user", entityId: req.params.id });
    return reply.send({ ok: true });
  });

  // ── Split rules (SPEC 8.1) ─────────────────────────────────────────────────

  const rule = z.object({
    serviceId: uuid.nullable(),
    // "servingStaff" = whoever served the customer; or one named staff member.
    staffUserId: uuid.nullable(),
    basisPoints: z.number().int().min(0).max(10000),
  });

  app.get("/v1/merchant/split-rules", { preHandler: staff }, async (req) => {
    const rows = await db
      .selectFrom("split_rules")
      .select(["id", "service_id", "party_kind", "party_user_id", "basis_points"])
      .where("merchant_id", "=", me(req).merchantId)
      .where("applies_to", "=", "sale")
      .where("active", "=", true)
      .execute();
    return { items: rows.filter((r) => r.party_kind === "staff").map((r) => ({ id: r.id, serviceId: r.service_id, staffUserId: r.party_user_id, basisPoints: r.basis_points })) };
  });

  /**
   * Replace the sale split rules. Each scope (merchant default, or one service) gives staff
   * shares; the merchant keeps the rest, so a scope may not exceed 100%. Applies to payments
   * from now on; past ledger lines never change.
   */
  app.put("/v1/merchant/split-rules", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const b = z.object({ rules: z.array(rule).max(50) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const byScope = new Map<string, number>();
    for (const r of b.data.rules) byScope.set(r.serviceId ?? "default", (byScope.get(r.serviceId ?? "default") ?? 0) + r.basisPoints);
    for (const [scope, total] of byScope) if (total > 10000) return reply.code(422).send({ code: "over_100", message: `staff shares for ${scope} add up to more than 100%` });
    const services = [...new Set(b.data.rules.map((r) => r.serviceId).filter((x): x is string => Boolean(x)))];
    const users = [...new Set(b.data.rules.map((r) => r.staffUserId).filter((x): x is string => Boolean(x)))];
    if (services.length) {
      const n = await db.selectFrom("services").select("id").where("merchant_id", "=", s.merchantId).where("id", "in", services).execute();
      if (n.length !== services.length) return reply.code(404).send({ code: "not_found", message: "service not found" });
    }
    if (users.length) {
      const n = await db.selectFrom("users").select("id").where("merchant_id", "=", s.merchantId).where("id", "in", users).execute();
      if (n.length !== users.length) return reply.code(404).send({ code: "not_found", message: "staff member not found" });
    }
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("split_rules").set({ active: false }).where("merchant_id", "=", s.merchantId).where("applies_to", "=", "sale").execute();
      if (b.data.rules.length) {
        await trx
          .insertInto("split_rules")
          .values(b.data.rules.map((r) => ({ merchant_id: s.merchantId, applies_to: "sale" as const, service_id: r.serviceId, user_id: null, party_kind: "staff" as const, party_user_id: r.staffUserId, basis_points: r.basisPoints })))
          .execute();
      }
      await audit(trx, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "split_rules.replaced", entity: "merchant", entityId: s.merchantId, detail: { rules: b.data.rules } });
    });
    return reply.send({ ok: true });
  });

  // ── Money and tip settings ─────────────────────────────────────────────────

  app.get("/v1/merchant/settings", { preHandler: staff }, async (req) => {
    const m = await db
      .selectFrom("merchants")
      .select(["tips_enabled", "tip_presets", "tip_min_cents", "tip_max_bp", "tip_max_cents", "tip_rule", "tip_house_cut_bp", "fee_policy", "payout_threshold_cents", "notify_managers", "quick_tip_presets_cents", "reminder_count", "reminder_first_delay_minutes", "reminder_window_start", "reminder_window_end"])
      .where("id", "=", me(req).merchantId)
      .executeTakeFirstOrThrow();
    return {
      tipsEnabled: m.tips_enabled,
      tipPresets: m.tip_presets,
      tipMinCents: m.tip_min_cents,
      tipMaxBp: m.tip_max_bp,
      tipMaxCents: m.tip_max_cents,
      tipRule: m.tip_rule,
      tipHouseCutBp: m.tip_house_cut_bp,
      feePolicy: m.fee_policy,
      payoutThresholdCents: m.payout_threshold_cents,
      notifyManagers: m.notify_managers,
      quickTipPresetsCents: m.quick_tip_presets_cents,
      reminderCount: m.reminder_count,
      reminderFirstDelayMinutes: m.reminder_first_delay_minutes,
      reminderWindowStart: m.reminder_window_start,
      reminderWindowEnd: m.reminder_window_end,
    };
  });

  app.patch("/v1/merchant/settings", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const b = z
      .object({
        tipsEnabled: z.boolean(),
        tipPresets: z.array(z.number().int().min(1).max(100)).max(4),
        tipMinCents: z.number().int().positive(),
        tipMaxBp: z.number().int().min(1).max(10000),
        tipMaxCents: z.number().int().positive().nullable(),
        tipRule: z.enum(["direct", "pool", "house_cut"]),
        tipHouseCutBp: z.number().int().min(0).max(10000),
        feePolicy: z.enum(["proportional", "merchant_absorbs"]),
        payoutThresholdCents: z.number().int().min(0).max(10_000_000),
        notifyManagers: z.enum(["each_payment", "daily_summary", "off"]),
        quickTipPresetsCents: z.array(z.number().int().positive()).min(1).max(9),
        reminderCount: z.number().int().min(0).max(3),
        reminderFirstDelayMinutes: z.number().int().min(1).max(1440),
        reminderWindowStart: z.number().int().min(8).max(19),
        reminderWindowEnd: z.number().int().min(9).max(20),
      })
      .partial()
      .strict()
      .safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const v = b.data;
    if (v.reminderWindowStart !== undefined || v.reminderWindowEnd !== undefined) {
      const cur = await db.selectFrom("merchants").select(["reminder_window_start", "reminder_window_end"]).where("id", "=", s.merchantId).executeTakeFirstOrThrow();
      if ((v.reminderWindowStart ?? cur.reminder_window_start) >= (v.reminderWindowEnd ?? cur.reminder_window_end)) {
        return reply.code(422).send({ code: "bad_window", message: "reminders start before they end, between 08:00 and 20:00" });
      }
    }
    const set = {
      ...(v.tipsEnabled !== undefined && { tips_enabled: v.tipsEnabled }),
      ...(v.tipPresets !== undefined && { tip_presets: v.tipPresets }),
      ...(v.tipMinCents !== undefined && { tip_min_cents: v.tipMinCents }),
      ...(v.tipMaxBp !== undefined && { tip_max_bp: v.tipMaxBp }),
      ...(v.tipMaxCents !== undefined && { tip_max_cents: v.tipMaxCents }),
      ...(v.tipRule !== undefined && { tip_rule: v.tipRule }),
      ...(v.tipHouseCutBp !== undefined && { tip_house_cut_bp: v.tipHouseCutBp }),
      ...(v.feePolicy !== undefined && { fee_policy: v.feePolicy }),
      ...(v.payoutThresholdCents !== undefined && { payout_threshold_cents: v.payoutThresholdCents }),
      ...(v.notifyManagers !== undefined && { notify_managers: v.notifyManagers }),
      ...(v.quickTipPresetsCents !== undefined && { quick_tip_presets_cents: v.quickTipPresetsCents }),
      ...(v.reminderCount !== undefined && { reminder_count: v.reminderCount }),
      ...(v.reminderFirstDelayMinutes !== undefined && { reminder_first_delay_minutes: v.reminderFirstDelayMinutes }),
      ...(v.reminderWindowStart !== undefined && { reminder_window_start: v.reminderWindowStart }),
      ...(v.reminderWindowEnd !== undefined && { reminder_window_end: v.reminderWindowEnd }),
    };
    if (Object.keys(set).length === 0) return reply.code(422).send({ code: "empty", message: "nothing to change" });
    await db.updateTable("merchants").set(set).where("id", "=", s.merchantId).execute();
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "settings.changed", entity: "merchant", entityId: s.merchantId, detail: v });
    return reply.send({ ok: true });
  });

  // ── Tip-pool shifts (SPEC 8.1) ─────────────────────────────────────────────

  app.get("/v1/merchant/shifts/current", { preHandler: staff }, async (req, reply) => {
    const s = me(req);
    const shift = await db.selectFrom("shifts").select(["id", "starts_at", "tip_pool"]).where("merchant_id", "=", s.merchantId).where("ends_at", "is", null).executeTakeFirst();
    if (!shift) return reply.code(404).send({ code: "none", message: "no shift running" });
    const members = await db
      .selectFrom("shift_members")
      .innerJoin("users", "users.id", "shift_members.user_id")
      .select(["users.id", "users.display_name", "shift_members.weight"])
      .where("shift_id", "=", shift.id)
      .execute();
    return { id: shift.id, startsAt: shift.starts_at, tipPool: shift.tip_pool, members: members.map((m) => ({ userId: m.id, name: m.display_name, weight: m.weight })) };
  });

  /** Start a tip-pool shift (ends any running one). Weight = share of the pool, e.g. hours. */
  app.post("/v1/merchant/shifts", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const b = z.object({ members: z.array(z.object({ userId: uuid, weight: z.number().int().min(1).max(100).default(1) })).min(1).max(50) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const ids = b.data.members.map((m) => m.userId);
    const found = await db.selectFrom("users").select("id").where("merchant_id", "=", s.merchantId).where("active", "=", true).where("id", "in", ids).execute();
    if (found.length !== new Set(ids).size) return reply.code(404).send({ code: "not_found", message: "staff member not found" });
    const now = d.clock.now();
    const id = await db.transaction().execute(async (trx) => {
      await trx.updateTable("shifts").set({ ends_at: now }).where("merchant_id", "=", s.merchantId).where("ends_at", "is", null).execute();
      const shift = await trx.insertInto("shifts").values({ merchant_id: s.merchantId, starts_at: now, ends_at: null, tip_pool: true }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("shift_members").values(b.data.members.map((m) => ({ shift_id: shift.id, user_id: m.userId, weight: m.weight }))).execute();
      await audit(trx, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "shift.started", entity: "shift", entityId: shift.id });
      return shift.id;
    });
    return reply.code(201).send({ id });
  });

  app.post("/v1/merchant/shifts/current/end", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const r = await db.updateTable("shifts").set({ ends_at: d.clock.now() }).where("merchant_id", "=", s.merchantId).where("ends_at", "is", null).executeTakeFirst();
    return r.numUpdatedRows === 1n ? reply.send({ ok: true }) : reply.code(404).send({ code: "none", message: "no shift running" });
  });
}
