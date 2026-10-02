import type { FastifyBaseLogger } from "fastify";
import { cents, decideReminder, firstReminderDue, formatRands, MAX_REMINDERS, nextAllowed, type Clock, type ReminderPolicy, type WhatsAppClient } from "@tappay/core";
import type { Config } from "@tappay/config";
import { audit, logMessage, sql, type Crypto, type Database, type Kysely, type Transaction } from "@tappay/db";

/**
 * Reminders for unpaid bills (SPEC 11). A bill becomes `abandoned` when its customer leaves
 * without paying; reminders are then planned one at a time in `reminders`, and the
 * `reminder.send` job sends what is due. The timing rules (at most 3, one per SAST day, only
 * 08:00 to 20:00) are the pure `decideReminder` in packages/core, property-tested there.
 *
 * Stop at once when the bill is paid (any way), cancelled, written off or marked paid another
 * way, when the customer replied STOP (for this merchant or all), or when the merchant turned
 * reminders off for the service. Every send is a WhatsApp template: by now the customer is
 * usually outside the 24-hour window (SPEC 11.3).
 */

type Db = Kysely<Database> | Transaction<Database>;
const UNPAID = ["abandoned", "needs_follow_up"] as const;

export interface ReminderEvents {
  billChanged(e: { merchantId: string; billId: string; name: string; staffUserId: string | null; createdBy: string | null; payload?: Record<string, unknown> }): Promise<void>;
}

export class ReminderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export function policyOf(m: { reminder_count: number; reminder_first_delay_minutes: number; reminder_window_start: number; reminder_window_end: number }): ReminderPolicy {
  return { count: m.reminder_count, firstDelayMinutes: m.reminder_first_delay_minutes, windowStartHour: m.reminder_window_start, windowEndHour: m.reminder_window_end };
}

/** Is this customer opted out of this merchant's reminders (or everyone's)? */
export async function optedOut(db: Db, customerId: string, merchantId: string): Promise<boolean> {
  const r = await db
    .selectFrom("opt_outs")
    .select("id")
    .where("customer_id", "=", customerId)
    .where((eb) => eb.or([eb("merchant_id", "is", null), eb("merchant_id", "=", merchantId)]))
    .executeTakeFirst();
  return Boolean(r);
}

export class Reminders {
  constructor(private readonly d: { db: Kysely<Database>; wa: WhatsAppClient; crypto: Crypto; config: Config; clock: Clock; log: FastifyBaseLogger; events?: ReminderEvents }) {}

  private now() {
    return this.d.clock.now();
  }

  /**
   * Plan the first reminder for a bill that just became abandoned (in the caller's
   * transaction). No reminders (merchant set 0, service off, customer opted out): the bill
   * goes straight to the merchant's follow-up list.
   */
  async planFirst(trx: Db, bill: { id: string; merchantId: string; customerId: string; abandonedAt: Date }): Promise<"planned" | "follow_up"> {
    const m = await trx.selectFrom("merchants").select(["reminder_count", "reminder_first_delay_minutes", "reminder_window_start", "reminder_window_end"]).where("id", "=", bill.merchantId).executeTakeFirstOrThrow();
    const policy = policyOf(m);
    const blocked = policy.count === 0 || (await this.serviceOff(trx, bill.id)) || (await optedOut(trx, bill.customerId, bill.merchantId));
    const already = await trx.selectFrom("reminders").select(["seq", "status"]).where("bill_id", "=", bill.id).execute();
    if (blocked || already.some((r) => r.status === "scheduled")) {
      if (blocked) await this.toFollowUp(trx, bill.id);
      return blocked ? "follow_up" : "planned";
    }
    // Abandoned again after an earlier round: carry on from where the count stands.
    const used = already.filter((r) => r.status === "sent" || r.status === "failed").length;
    if (used >= Math.min(policy.count, MAX_REMINDERS)) {
      await this.toFollowUp(trx, bill.id);
      return "follow_up";
    }
    const last = await this.lastSent(trx, bill.id);
    const due = used === 0 ? firstReminderDue(bill.abandonedAt, policy) : nextAllowed(bill.abandonedAt, last, policy);
    await trx
      .insertInto("reminders")
      .values({ bill_id: bill.id, customer_id: bill.customerId, merchant_id: bill.merchantId, seq: used + 1, due_at: due, sent_at: null, template: null, error: null })
      .onConflict((oc) => oc.columns(["bill_id", "seq"]).doNothing())
      .execute();
    return "planned";
  }

  private async serviceOff(db: Db, billId: string): Promise<boolean> {
    const r = await sql<{ off: boolean }>`
      select exists (
        select 1 from bills b cross join lateral jsonb_array_elements(b.lines) e
        join services s on s.id::text = e->>'serviceId' and s.merchant_id = b.merchant_id
        where b.id = ${billId} and s.reminders_enabled = false
      ) as off`.execute(db);
    return Boolean(r.rows[0]?.off);
  }

  private async lastSent(db: Db, billId: string): Promise<Date | null> {
    const r = await db.selectFrom("reminders").select((eb) => eb.fn.max("sent_at").as("t")).where("bill_id", "=", billId).executeTakeFirst();
    return (r?.t as Date | null | undefined) ?? null;
  }

  private async toFollowUp(db: Db, billId: string) {
    await db.updateTable("bills").set({ status: "needs_follow_up", version: sql`version + 1` }).where("id", "=", billId).where("status", "=", "abandoned").execute();
  }

  /** Cancel whatever is still planned for a bill (paid, cancelled, written off, marked paid). */
  async cancelForBill(db: Db, billId: string, reason: string): Promise<void> {
    await db.updateTable("reminders").set({ status: "cancelled", error: reason }).where("bill_id", "=", billId).where("status", "=", "scheduled").execute();
  }

  /** STOP (one merchant) or STOP ALL (merchantId null). */
  async optOut(customerId: string, merchantId: string | null): Promise<void> {
    const { db } = this.d;
    const now = this.now();
    await db.transaction().execute(async (trx) => {
      await sql`insert into opt_outs (customer_id, merchant_id) values (${customerId}, ${merchantId}) on conflict do nothing`.execute(trx);
      if (!merchantId) await trx.updateTable("customers").set({ opted_out_at: now }).where("id", "=", customerId).execute();
      let q = trx.updateTable("reminders").set({ status: "cancelled", error: "opted_out" }).where("customer_id", "=", customerId).where("status", "=", "scheduled");
      if (merchantId) q = q.where("merchant_id", "=", merchantId);
      await q.execute();
      await audit(trx, { merchantId, actorKind: "customer", actorId: customerId, action: merchantId ? "customer.opt_out_merchant" : "customer.opt_out", entity: "customer", entityId: customerId });
    });
  }

  /** The reminder.send job: everything due now. */
  async runDue(limit = 200): Promise<{ sent: number; deferred: number; cancelled: number }> {
    const due = await this.d.db.selectFrom("reminders").select("id").where("status", "=", "scheduled").where("due_at", "<=", this.now()).orderBy("due_at").limit(limit).execute();
    const out = { sent: 0, deferred: 0, cancelled: 0 };
    for (const { id } of due) {
      try {
        const r = await this.processOne(id);
        if (r === "sent") out.sent++;
        else if (r === "deferred") out.deferred++;
        else if (r === "cancelled") out.cancelled++;
      } catch (e) {
        this.d.log.error({ err: (e as Error).message }, "reminder failed");
      }
    }
    return out;
  }

  /**
   * Decide and, if allowed now, send one reminder. Marked sent before the message goes, so a
   * crash can lose one but never send it twice (the cap is a promise to the customer).
   */
  async processOne(reminderId: string): Promise<"sent" | "deferred" | "cancelled" | "busy"> {
    const { db, config } = this.d;
    const now = this.now();
    const plan = await db.transaction().execute(async (trx) => {
      const r = await sql<{ id: string; bill_id: string; customer_id: string; seq: number; status: string }>`
        select id, bill_id, customer_id, seq, status from reminders where id = ${reminderId} for update skip locked`.execute(trx);
      const row = r.rows[0];
      if (!row || row.status !== "scheduled") return { kind: "busy" as const };
      const bill = await trx
        .selectFrom("bills")
        .innerJoin("merchants", "merchants.id", "bills.merchant_id")
        .innerJoin("customers", "customers.id", "bills.customer_id")
        .select([
          "bills.id",
          "bills.merchant_id",
          "bills.status",
          "bills.subtotal_cents",
          "bills.bill_token",
          "bills.abandoned_at",
          "bills.customer_id",
          "bills.assigned_user_id",
          "bills.created_by",
          "merchants.name",
          "merchants.status as merchantStatus",
          "merchants.reminder_count",
          "merchants.reminder_first_delay_minutes",
          "merchants.reminder_window_start",
          "merchants.reminder_window_end",
          "customers.msisdn_enc",
        ])
        .where("bills.id", "=", row.bill_id)
        .executeTakeFirst();
      const cancel = async (reason: string) => {
        await trx.updateTable("reminders").set({ status: "cancelled", error: reason }).where("id", "=", row.id).execute();
        return { kind: "cancelled" as const };
      };
      if (!bill || bill.customer_id !== row.customer_id) return cancel("bill_changed");
      // The customer is paying right now: look again after the session's time.
      if (bill.status === "claimed") {
        await trx.updateTable("reminders").set({ due_at: new Date(now.getTime() + config.SESSION_TTL_MINUTES * 60_000) }).where("id", "=", row.id).execute();
        return { kind: "deferred" as const };
      }
      if (!(UNPAID as readonly string[]).includes(bill.status)) return cancel(`bill_${bill.status}`);
      if (bill.merchantStatus !== "active") return cancel("merchant_inactive");
      if (await optedOut(trx, row.customer_id, bill.merchant_id)) return cancel("opted_out");
      if (await this.serviceOff(trx, bill.id)) return cancel("service_off");

      const policy = policyOf(bill);
      const history = await trx.selectFrom("reminders").select(["status", "sent_at"]).where("bill_id", "=", bill.id).where("status", "in", ["sent", "failed"]).execute();
      const lastSentAt = history.reduce<Date | null>((a, h) => (h.sent_at && (!a || h.sent_at > a) ? h.sent_at : a), null);
      const decision = decideReminder({ seq: row.seq, now, abandonedAt: bill.abandoned_at ?? now, lastSentAt, sentCount: history.length, policy });
      if (decision.action === "stop") {
        await this.toFollowUp(trx, bill.id);
        return cancel("cap");
      }
      if (decision.action === "defer") {
        await trx.updateTable("reminders").set({ due_at: decision.dueAt }).where("id", "=", row.id).execute();
        return { kind: "deferred" as const };
      }
      // The last one says it is the last (MESSAGES reminder_3).
      const template = decision.isLast ? "reminder_3" : row.seq === 1 ? "reminder_1" : "reminder_2";
      await trx.updateTable("reminders").set({ status: "sent", sent_at: now, template }).where("id", "=", row.id).execute();
      if (decision.next) {
        await trx
          .insertInto("reminders")
          .values({ bill_id: bill.id, customer_id: row.customer_id, merchant_id: bill.merchant_id, seq: decision.next.seq, due_at: decision.next.dueAt, sent_at: null, template: null, error: null })
          .onConflict((oc) => oc.columns(["bill_id", "seq"]).doNothing())
          .execute();
      } else {
        // After the last reminder the bill waits in the merchant's follow-up list (SPEC 11.2).
        await this.toFollowUp(trx, bill.id);
      }
      await audit(trx, { merchantId: bill.merchant_id, actorKind: "system", actorId: null, action: "reminder.sent", entity: "bill", entityId: bill.id, detail: { seq: row.seq, template } });
      return {
        kind: "send" as const,
        id: row.id,
        to: this.d.crypto.decrypt(bill.msisdn_enc),
        template,
        params: [formatRands(cents(bill.subtotal_cents)), bill.name, `${config.PUBLIC_API_URL}/b/${bill.bill_token}`],
        bill: { merchantId: bill.merchant_id, id: bill.id, staffUserId: bill.assigned_user_id, createdBy: bill.created_by },
        customerId: row.customer_id,
      };
    });
    if (plan.kind !== "send") return plan.kind;
    try {
      const r = await this.d.wa.sendTemplate(plan.to, plan.template, "en", plan.params);
      await logMessage(db, { customerId: plan.customerId, merchantId: plan.bill.merchantId, direction: "out", waMessageId: r.messageId, kind: "template", template: plan.template });
    } catch (e) {
      this.d.log.error({ err: (e as Error).message }, "reminder send failed");
      await db.updateTable("reminders").set({ status: "failed", error: (e as Error).name }).where("id", "=", plan.id).execute();
    }
    try {
      await this.d.events?.billChanged({ merchantId: plan.bill.merchantId, billId: plan.bill.id, name: "bill.reminded", staffUserId: plan.bill.staffUserId, createdBy: plan.bill.createdBy });
    } catch {
      /* live event is best effort */
    }
    return "sent";
  }

  /**
   * "Send reminder" from the Unpaid list (SPEC 11.4). It counts toward the cap and follows the
   * same rules: sent now if allowed, otherwise queued for the next allowed moment.
   */
  async remindNow(merchantId: string, billId: string, actorUserId: string): Promise<{ status: "sent" | "queued"; dueAt: Date }> {
    const { db } = this.d;
    const now = this.now();
    const bill = await db
      .selectFrom("bills")
      .innerJoin("merchants", "merchants.id", "bills.merchant_id")
      .select(["bills.id", "bills.status", "bills.customer_id", "bills.abandoned_at", "merchants.reminder_count"])
      .where("bills.merchant_id", "=", merchantId)
      .where("bills.id", "=", billId)
      .executeTakeFirst();
    if (!bill) throw new ReminderError("not_found", "bill not found", 404);
    if (!(UNPAID as readonly string[]).includes(bill.status) || !bill.customer_id) throw new ReminderError("not_unpaid", "only unpaid bills with a known customer get reminders");
    if (await optedOut(db, bill.customer_id, merchantId)) throw new ReminderError("opted_out", "this customer asked for no reminders; follow up in person");
    let row = await db.selectFrom("reminders").select("id").where("bill_id", "=", billId).where("status", "=", "scheduled").executeTakeFirst();
    if (!row) {
      const used = await db.selectFrom("reminders").select((eb) => eb.fn.countAll<number>().as("n")).where("bill_id", "=", billId).where("status", "in", ["sent", "failed"]).executeTakeFirstOrThrow();
      const n = Number(used.n);
      if (n >= Math.min(bill.reminder_count, MAX_REMINDERS)) throw new ReminderError("reminder_cap", `all ${n} reminders for this bill have been sent`, 429);
      row = await db
        .insertInto("reminders")
        .values({ bill_id: billId, customer_id: bill.customer_id, merchant_id: merchantId, seq: n + 1, due_at: now, sent_at: null, template: null, error: null })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (bill.status === "needs_follow_up") await db.updateTable("bills").set({ status: "abandoned", version: sql`version + 1` }).where("id", "=", billId).where("status", "=", "needs_follow_up").execute();
    } else {
      await db.updateTable("reminders").set({ due_at: now }).where("id", "=", row.id).execute();
    }
    await audit(db, { merchantId, actorKind: "user", actorId: actorUserId, action: "reminder.requested", entity: "bill", entityId: billId });
    const r = await this.processOne(row.id);
    if (r === "sent") return { status: "sent", dueAt: now };
    const after = await db.selectFrom("reminders").select(["due_at", "status", "error"]).where("id", "=", row.id).executeTakeFirstOrThrow();
    if (after.status === "cancelled") throw new ReminderError(after.error ?? "cancelled", "no reminder can be sent for this bill");
    return { status: "queued", dueAt: after.due_at };
  }
}
