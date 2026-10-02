import type { FastifyBaseLogger } from "fastify";
import { type Clock } from "@tappay/core";
import { maskMsisdn, sql, type Crypto, type Database, type Kysely } from "@tappay/db";
import { methodLabel } from "@tappay/slip";
import type { Notifier } from "./notifier.js";

/**
 * Reports (SPEC 16) and the end-of-day summary (SPEC 12). Days are South African dates. A payment
 * belongs to the day it was confirmed (`paid_at`); a refund to the day it settled. Every report
 * also adds up the ledger lines for the same payments and refunds, and says whether the two
 * agree (M6 acceptance: totals reconcile with the ledger).
 */

const TZ = "Africa/Johannesburg";
export const sastDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
/** SAST has no daylight saving: midnight is always 22:00 UTC the day before. */
const dayStart = (date: string) => new Date(`${date}T00:00:00+02:00`);
const addDays = (date: string, n: number) => sastDate(new Date(dayStart(date).getTime() + n * 86_400_000 + 3_600_000));

export class ReportError extends Error {}

export interface Range {
  from: string;
  to: string;
}

export function parseRange(q: { from?: string | undefined; to?: string | undefined }, now: Date): Range {
  const today = sastDate(now);
  const from = q.from ?? today;
  const to = q.to ?? from;
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayStart(s).getTime()) && sastDate(dayStart(s)) === s;
  if (!ok(from) || !ok(to)) throw new ReportError("dates must be YYYY-MM-DD");
  if (to < from) throw new ReportError("to is before from");
  if (dayStart(to).getTime() - dayStart(from).getTime() > 366 * 86_400_000) throw new ReportError("at most 366 days");
  return { from, to };
}

type Db = Kysely<Database>;

export class Reports {
  constructor(private readonly d: { db: Db; crypto: Crypto; clock: Clock; log: FastifyBaseLogger; notifier: Notifier }) {}

  /** Payments confirmed in the range; staff see payments on their own bills. */
  private payments(merchantId: string, r: Range, onlyUserId: string | null) {
    let q = this.d.db
      .selectFrom("payments")
      .innerJoin("sessions", "sessions.id", "payments.session_id")
      .leftJoin("bills", "bills.id", "sessions.bill_id")
      .where("payments.merchant_id", "=", merchantId)
      .where("payments.status", "in", ["succeeded", "partially_refunded", "refunded"])
      .where("payments.paid_at", ">=", dayStart(r.from))
      .where("payments.paid_at", "<", dayStart(addDays(r.to, 1)));
    if (onlyUserId) q = q.where((eb) => eb.or([eb("bills.created_by", "=", onlyUserId), eb("bills.assigned_user_id", "=", onlyUserId)]));
    return q;
  }

  private refunds(merchantId: string, r: Range, onlyUserId: string | null) {
    let q = this.d.db
      .selectFrom("refunds")
      .innerJoin("payments", "payments.id", "refunds.payment_id")
      .innerJoin("sessions", "sessions.id", "payments.session_id")
      .leftJoin("bills", "bills.id", "sessions.bill_id")
      .where("refunds.merchant_id", "=", merchantId)
      .where("refunds.status", "=", "succeeded")
      .where("refunds.settled_at", ">=", dayStart(r.from))
      .where("refunds.settled_at", "<", dayStart(addDays(r.to, 1)));
    if (onlyUserId) q = q.where((eb) => eb.or([eb("bills.created_by", "=", onlyUserId), eb("bills.assigned_user_id", "=", onlyUserId)]));
    return q;
  }

  async summary(merchantId: string, r: Range, onlyUserId: string | null = null) {
    const { db } = this.d;
    const totals = await this.payments(merchantId, r, onlyUserId)
      .select((eb) => [
        eb.fn.countAll<number>().as("count"),
        eb.fn.coalesce(eb.fn.sum<number>("payments.amount_cents"), eb.lit(0)).as("gross"),
        eb.fn.coalesce(eb.fn.sum<number>("sessions.base_cents"), eb.lit(0)).as("base"),
        eb.fn.coalesce(eb.fn.sum<number>("sessions.tip_cents"), eb.lit(0)).as("tips"),
        eb.fn.coalesce(eb.fn.sum<number>("payments.provider_fee_cents"), eb.lit(0)).as("fees"),
      ])
      .executeTakeFirstOrThrow();
    const refunds = await this.refunds(merchantId, r, onlyUserId)
      .select((eb) => [eb.fn.countAll<number>().as("count"), eb.fn.coalesce(eb.fn.sum<number>("refunds.amount_cents"), eb.lit(0)).as("amount")])
      .executeTakeFirstOrThrow();

    // The same money, read from the ledger.
    const payIds = this.payments(merchantId, r, onlyUserId).select("payments.id");
    const refundIds = this.refunds(merchantId, r, onlyUserId).select("refunds.id");
    const ledger = await db
      .selectFrom("ledger_entries")
      .select([
        sql<number>`coalesce(sum(amount_cents) filter (where kind in ('sale','tip') and payment_id in (${payIds})), 0)`.as("credits"),
        sql<number>`coalesce(-sum(amount_cents) filter (where kind = 'fee' and payment_id in (${payIds})), 0)`.as("fees"),
        sql<number>`coalesce(-sum(amount_cents) filter (where kind = 'refund' and refund_id in (${refundIds})), 0)`.as("refunds"),
      ])
      .where("merchant_id", "=", merchantId)
      .executeTakeFirstOrThrow();

    const byDay = await this.payments(merchantId, r, onlyUserId)
      .select([
        sql<string>`to_char(payments.paid_at at time zone ${TZ}, 'YYYY-MM-DD')`.as("date"),
        (eb) => eb.fn.countAll<number>().as("count"),
        (eb) => eb.fn.sum<number>("payments.amount_cents").as("gross"),
        (eb) => eb.fn.coalesce(eb.fn.sum<number>("sessions.tip_cents"), eb.lit(0)).as("tips"),
      ])
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .execute();

    // Who earned what, from the ledger (sale and tip credits less fees, and refunds in range).
    const partyRows = await db
      .selectFrom("ledger_entries")
      .leftJoin("users", "users.id", "ledger_entries.party_user_id")
      .select([
        "ledger_entries.party_kind",
        "ledger_entries.party_user_id",
        "users.display_name",
        sql<number>`coalesce(sum(amount_cents) filter (where kind = 'sale' and payment_id in (${payIds})), 0)`.as("sales"),
        sql<number>`coalesce(sum(amount_cents) filter (where kind = 'tip' and payment_id in (${payIds})), 0)`.as("tips"),
        sql<number>`coalesce(sum(amount_cents) filter (where kind in ('fee','platform_fee') and payment_id in (${payIds})), 0)`.as("fees"),
        sql<number>`coalesce(sum(amount_cents) filter (where kind = 'refund' and refund_id in (${refundIds})), 0)`.as("refunds"),
      ])
      .where("ledger_entries.merchant_id", "=", merchantId)
      .where((eb) => eb.or([eb("ledger_entries.payment_id", "in", payIds), eb("ledger_entries.refund_id", "in", refundIds)]))
      .groupBy(["ledger_entries.party_kind", "ledger_entries.party_user_id", "users.display_name"])
      .execute();
    const byParty = partyRows
      .filter((p) => !onlyUserId || p.party_user_id === onlyUserId)
      .map((p) => {
        const [sales, tips, fees, refunded] = [Number(p.sales), Number(p.tips), Number(p.fees), Number(p.refunds)];
        return {
          partyKind: p.party_kind,
          userId: p.party_user_id,
          name: p.party_kind === "staff" ? p.display_name : p.party_kind === "pool" ? "Tip pool (no shift)" : "Business",
          salesCents: sales,
          tipCents: tips,
          feeCents: fees,
          refundCents: refunded,
          netCents: sales + tips + fees + refunded,
        };
      })
      .sort((a, b) => (a.partyKind === "merchant" ? -1 : b.partyKind === "merchant" ? 1 : (a.name ?? "").localeCompare(b.name ?? "")));

    // What sold: bill lines (VAT-inclusive, before tip). A table share is counted by its amount.
    const lineRows = await sql<{ service_id: string | null; name: string; count: number; amount: number }>`
      with p as (${this.payments(merchantId, r, onlyUserId).select(["payments.id", "sessions.bill_share_id", "sessions.base_cents", "bills.lines", "bills.type"])}),
      l as (
        select p.id, e->>'serviceId' as service_id, e->>'description' as description,
               (e->>'amountCents')::bigint * coalesce((e->>'quantity')::int, 1) as amount
        from p cross join lateral jsonb_array_elements(coalesce(p.lines, '[]'::jsonb)) e
        where p.bill_share_id is null and p.type <> 'quick_tip'
        union all
        select p.id, null, 'Shared bills', p.base_cents from p where p.bill_share_id is not null
        union all
        select p.id, null, 'Amount', p.base_cents from p
          where p.bill_share_id is null and p.type <> 'quick_tip' and jsonb_array_length(coalesce(p.lines, '[]'::jsonb)) = 0 and p.base_cents > 0
      )
      select l.service_id, coalesce(s.name, case when l.service_id is null and l.description in ('Shared bills','Amount') then l.description else 'Other items' end) as name,
             count(distinct l.id)::int as count, sum(l.amount)::bigint as amount
      from l left join services s on s.id::text = l.service_id and s.merchant_id = ${merchantId}
      group by 1, 2 order by 4 desc`.execute(db);

    const gross = Number(totals.gross);
    const fees = Number(totals.fees);
    const refundAmount = Number(refunds.amount);
    const ledgerTotals = { creditsCents: Number(ledger.credits), feeCents: Number(ledger.fees), refundCents: Number(ledger.refunds) };
    return {
      from: r.from,
      to: r.to,
      count: Number(totals.count),
      grossCents: gross,
      baseCents: Number(totals.base),
      tipCents: Number(totals.tips),
      feeCents: fees,
      refundCount: Number(refunds.count),
      refundCents: refundAmount,
      netCents: gross - refundAmount - fees,
      ledger: ledgerTotals,
      reconciled: ledgerTotals.creditsCents === gross && ledgerTotals.feeCents === fees && ledgerTotals.refundCents === refundAmount,
      byDay: byDay.map((x) => ({ date: x.date, count: Number(x.count), grossCents: Number(x.gross), tipCents: Number(x.tips) })),
      byParty,
      byService: lineRows.rows.map((x) => ({ serviceId: x.service_id, name: x.name, count: Number(x.count), amountCents: Number(x.amount) })),
    };
  }

  /** CSV for the accountant: one row per payment in the range. Amounts in rand with a dot. */
  async csv(merchantId: string, r: Range): Promise<string> {
    const rows = await this.payments(merchantId, r, null)
      .leftJoin("receipts", "receipts.payment_id", "payments.id")
      .leftJoin("users", "users.id", "bills.assigned_user_id")
      .leftJoin("customers", "customers.id", "sessions.customer_id")
      .leftJoin("bill_shares", "bill_shares.id", "sessions.bill_share_id")
      .select([
        "payments.id",
        "payments.paid_at",
        "payments.amount_cents",
        "payments.refunded_cents",
        "payments.provider_fee_cents",
        "payments.method",
        "payments.status",
        "sessions.base_cents",
        "sessions.tip_cents",
        "receipts.number as receipt",
        "users.display_name as staff",
        "customers.msisdn_enc",
        "bills.lines",
        "bills.type",
        "bill_shares.label as share",
      ])
      .orderBy("payments.paid_at")
      .execute();
    const money = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
    const header = ["Date", "Time", "Receipt", "Description", "Staff", "Customer", "Bill", "Tip", "Total", "Refunded", "Card fee", "Net", "Method", "Status", "Payment ID"];
    const out = [header.map(csvCell).join(",")];
    for (const p of rows) {
      const description = p.type === "quick_tip" ? "Tip" : p.share ? `Share: ${p.share}` : (p.lines ?? []).map((l) => l.description).join("; ") || "Amount";
      const fee = p.provider_fee_cents ?? 0;
      out.push(
        [
          sastDate(p.paid_at!),
          time.format(p.paid_at!),
          p.receipt ?? "",
          description,
          p.staff ?? "",
          p.msisdn_enc ? maskMsisdn(this.d.crypto.decrypt(p.msisdn_enc)) : "",
          money(p.base_cents ?? 0),
          money(p.tip_cents),
          money(p.amount_cents),
          money(p.refunded_cents),
          money(fee),
          money(p.amount_cents - p.refunded_cents - fee),
          methodLabel(p.method),
          p.status,
          p.id,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return `${out.join("\r\n")}\r\n`;
  }

  /**
   * The summary job (summary.daily, 06:30 SAST): yesterday's totals to managers of merchants who
   * chose a daily summary instead of per-payment alerts. Safe to run twice (deduped per day).
   */
  async sendDailySummaries(): Promise<{ merchants: number; sent: number }> {
    const { db } = this.d;
    const date = addDays(sastDate(this.d.clock.now()), -1);
    const merchants = await db.selectFrom("merchants").select("id").where("status", "=", "active").where("notify_managers", "=", "daily_summary").execute();
    let sent = 0;
    for (const { id } of merchants) {
      try {
        const s = await this.summary(id, { from: date, to: date });
        const owed = await db
          .selectFrom("ledger_entries")
          .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_cents"), eb.lit(0)).as("n"))
          .where("merchant_id", "=", id)
          .where("party_kind", "=", "staff")
          .executeTakeFirstOrThrow();
        const label = new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, weekday: "short", day: "2-digit", month: "short" }).format(dayStart(date));
        sent += await this.d.notifier.dailySummary({ merchantId: id, date, label, count: s.count, totalCents: s.grossCents, tipCents: s.tipCents, refundCents: s.refundCents, owedCents: Number(owed.n) });
      } catch (e) {
        this.d.log.error({ merchantId: id, err: (e as Error).message }, "daily summary failed for merchant");
      }
    }
    return { merchants: merchants.length, sent };
  }
}

/** Quote a CSV cell; neutralise spreadsheet formulas (CSV injection). */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
