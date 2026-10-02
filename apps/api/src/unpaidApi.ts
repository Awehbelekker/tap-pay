import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Clock } from "@tappay/core";
import type { Config } from "@tappay/config";
import { maskMsisdn, sql, type Crypto, type Database, type Kysely } from "@tappay/db";
import { requireStaff, type Auth, type Staff } from "./auth.js";
import { FlowError, type PayFlow } from "./flow.js";
import { ReminderError } from "./reminders.js";

/**
 * The Unpaid list (SPEC 11.4): bills customers left without paying, with reminders sent and
 * due, and the actions Send reminder, Mark paid another way (reason required) and Write off.
 * Staff see and act on their own bills; write-off is for managers. The full customer number
 * shows only when the merchant typed it on the bill or the customer agreed to share it.
 */

export interface UnpaidApiDeps {
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  auth: Auth;
  flow: PayFlow;
  clock: Clock;
}

const uuid = z.string().uuid();
const isManager = (s: Staff) => s.role === "manager" || s.role === "owner";
const reasonBody = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

export function registerUnpaidApi(app: FastifyInstance, d: UnpaidApiDeps): void {
  const { db, crypto, config, flow } = d;
  const staff = requireStaff(d.auth);
  const manager = requireStaff(d.auth, ["owner", "manager"]);
  const me = (req: FastifyRequest) => req.staff!;

  /** The bill, if this person may act on it (managers: any; staff: their own). */
  async function ownBill(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const s = me(req);
    if (!uuid.safeParse(req.params.id).success) return void reply.code(404).send({ code: "not_found", message: "bill not found" });
    const b = await db.selectFrom("bills").select(["id", "created_by", "assigned_user_id"]).where("merchant_id", "=", s.merchantId).where("id", "=", req.params.id).executeTakeFirst();
    if (!b || (!isManager(s) && b.created_by !== s.userId && b.assigned_user_id !== s.userId)) return void reply.code(404).send({ code: "not_found", message: "bill not found" });
    return b;
  }
  const flowError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof FlowError) return reply.code(e.code === "not_found" ? 404 : 409).send({ code: e.code, message: e.message });
    if (e instanceof ReminderError) return reply.code(e.status).send({ code: e.code, message: e.message });
    throw e;
  };

  app.get("/v1/merchant/unpaid", { preHandler: staff }, async (req) => {
    const s = me(req);
    let q = db
      .selectFrom("bills")
      .leftJoin("customers", "customers.id", "bills.customer_id")
      .leftJoin("users", "users.id", "bills.assigned_user_id")
      .select([
        "bills.id",
        "bills.status",
        "bills.type",
        "bills.lines",
        "bills.subtotal_cents",
        "bills.abandoned_at",
        "bills.created_at",
        "bills.bill_token",
        "bills.intended_msisdn_enc",
        "bills.share_number_consent",
        "bills.customer_id",
        "customers.msisdn_enc",
        "customers.profile_name",
        "users.display_name as staffName",
        sql<number>`(select count(*)::int from reminders r where r.bill_id = bills.id and r.status in ('sent','failed'))`.as("sent"),
        sql<Date | null>`(select min(r.due_at) from reminders r where r.bill_id = bills.id and r.status = 'scheduled')`.as("next"),
        sql<boolean>`exists (select 1 from opt_outs o where o.customer_id = bills.customer_id and (o.merchant_id is null or o.merchant_id = bills.merchant_id))`.as("opted_out"),
      ])
      .where("bills.merchant_id", "=", s.merchantId)
      .where("bills.status", "in", ["abandoned", "needs_follow_up"]);
    if (!isManager(s)) q = q.where((eb) => eb.or([eb("bills.created_by", "=", s.userId), eb("bills.assigned_user_id", "=", s.userId)]));
    const rows = await q.orderBy("bills.abandoned_at", "desc").limit(200).execute();
    const limit = (await db.selectFrom("merchants").select("reminder_count").where("id", "=", s.merchantId).executeTakeFirstOrThrow()).reminder_count;
    return {
      items: rows.map((r) => {
        // SPEC 13: the full number only if the merchant typed it, or the customer agreed.
        const full = r.intended_msisdn_enc ? crypto.decrypt(r.intended_msisdn_enc) : r.share_number_consent && r.msisdn_enc ? crypto.decrypt(r.msisdn_enc) : null;
        const masked = r.msisdn_enc ? maskMsisdn(crypto.decrypt(r.msisdn_enc)) : null;
        return {
          id: r.id,
          status: r.status,
          description: (r.lines ?? []).map((l) => l.description).join(", ") || "Amount",
          amountCents: r.subtotal_cents,
          abandonedAt: r.abandoned_at ?? r.created_at,
          staffName: r.staffName,
          customer: { name: r.profile_name?.trim().split(/\s+/)[0] ?? null, maskedNumber: masked, number: full },
          remindersSent: Number(r.sent),
          reminderLimit: Math.max(limit, Number(r.sent)),
          nextReminderAt: r.next,
          optedOut: Boolean(r.opted_out),
          link: `${config.PUBLIC_API_URL}/b/${r.bill_token}`,
        };
      }),
    };
  });

  app.post<{ Params: { id: string } }>("/v1/merchant/bills/:id/remind", { preHandler: staff }, async (req, reply) => {
    const b = await ownBill(req, reply);
    if (!b) return reply;
    try {
      const r = await flow.reminders.remindNow(me(req).merchantId, b.id, me(req).userId);
      return reply.code(r.status === "sent" ? 200 : 202).send(r);
    } catch (e) {
      return flowError(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/merchant/bills/:id/mark-paid-other", { preHandler: staff }, async (req, reply) => {
    const b = await ownBill(req, reply);
    if (!b) return reply;
    const body = reasonBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send({ code: "reason_required", message: "say how it was paid, for example cash" });
    try {
      await flow.markPaidOther(me(req).merchantId, b.id, me(req).userId, body.data.reason);
      return reply.send({ ok: true });
    } catch (e) {
      return flowError(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/merchant/bills/:id/write-off", { preHandler: manager }, async (req, reply) => {
    const b = await ownBill(req, reply);
    if (!b) return reply;
    const body = reasonBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send({ code: "reason_required", message: "give a reason" });
    try {
      await flow.writeOff(me(req).merchantId, b.id, me(req).userId, body.data.reason);
      return reply.send({ ok: true });
    } catch (e) {
      return flowError(reply, e);
    }
  });
}
