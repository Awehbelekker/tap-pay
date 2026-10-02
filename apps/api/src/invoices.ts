import { cents, FULL_TAX_INVOICE_THRESHOLD_CENTS, newUrlToken, parseInvoiceDetails, vatIncluded, type Clock } from "@tappay/core";
import type { Config } from "@tappay/config";
import { audit, sql, type Database, type Kysely } from "@tappay/db";
import { formatSast, renderTaxInvoicePdf } from "@tappay/slip";
import { catalogue, type OutMessage } from "@tappay/whatsapp";

/**
 * Tax invoices on request (SPEC 14). The customer replies INVOICE on WhatsApp; we take their
 * latest payment from the last 30 days, and if the business is VAT registered, ask for company
 * name and VAT number, then issue a numbered invoice (per-merchant sequence) as a PDF behind an
 * unguessable link. One invoice per payment: asking again resends the same one.
 */

const LOOKBACK_DAYS = 30;
const DETAILS_WINDOW_MINUTES = 30;

export class TaxInvoices {
  constructor(private readonly d: { db: Kysely<Database>; config: Config; clock: Clock }) {}

  private now() {
    return this.d.clock.now();
  }

  private url(token: string) {
    return `${this.d.config.PUBLIC_API_URL}/i/${token}`;
  }

  /** "INVOICE": find the payment and ask for the buyer's details (or resend an issued one). */
  async request(customerId: string): Promise<{ merchantId: string | null; msg: OutMessage }> {
    const { db } = this.d;
    const now = this.now();
    const p = await db
      .selectFrom("payments")
      .innerJoin("sessions", "sessions.id", "payments.session_id")
      .innerJoin("merchants", "merchants.id", "payments.merchant_id")
      .leftJoin("bills", "bills.id", "sessions.bill_id")
      .select(["payments.id", "payments.merchant_id", "payments.amount_cents", "payments.paid_at", "sessions.base_cents", "bills.type as billType", "merchants.name", "merchants.vat_registered", "merchants.vat_number", "merchants.address"])
      .where("sessions.customer_id", "=", customerId)
      .where("payments.status", "in", ["succeeded", "partially_refunded"])
      .where("payments.paid_at", ">=", new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000))
      .orderBy("payments.paid_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!p) return { merchantId: null, msg: catalogue.invoiceNone() };
    if (!p.vat_registered) return { merchantId: p.merchant_id, msg: catalogue.invoiceNotVat({ merchant: p.name }) };
    if (!p.vat_number || !p.address) return { merchantId: p.merchant_id, msg: catalogue.invoiceUnavailable({ merchant: p.name }) };
    if (p.billType === "quick_tip" || !p.base_cents) return { merchantId: p.merchant_id, msg: catalogue.invoiceTipOnly() };

    const issued = await db.selectFrom("tax_invoices").select(["number", "token"]).where("payment_id", "=", p.id).where("status", "=", "issued").executeTakeFirst();
    if (issued) return { merchantId: p.merchant_id, msg: catalogue.invoiceReady({ merchant: p.name, number: issued.number!, url: this.url(issued.token!) }) };

    await db.transaction().execute(async (trx) => {
      await trx.updateTable("tax_invoices").set({ status: "expired" }).where("customer_id", "=", customerId).where("status", "=", "awaiting_details").execute();
      await trx
        .insertInto("tax_invoices")
        .values({ merchant_id: p.merchant_id, payment_id: p.id, customer_id: customerId, number: null, buyer_name: null, buyer_vat: null, buyer_address: null, token: null, expires_at: new Date(now.getTime() + DETAILS_WINDOW_MINUTES * 60_000), issued_at: null })
        .execute();
    });
    const date = formatSast(p.paid_at!).replace(/,.*$/, "");
    return { merchantId: p.merchant_id, msg: catalogue.invoiceAsk({ merchant: p.name, total: cents(p.amount_cents), date }) };
  }

  /** Whether this customer was just asked for their details. */
  async pending(customerId: string) {
    return this.d.db
      .selectFrom("tax_invoices")
      .select(["id", "merchant_id", "payment_id"])
      .where("customer_id", "=", customerId)
      .where("status", "=", "awaiting_details")
      .where("expires_at", ">", this.now())
      .orderBy("created_at", "desc")
      .executeTakeFirst();
  }

  /** The customer's reply with company name and VAT number: issue the invoice. */
  async details(pending: { id: string; merchant_id: string; payment_id: string }, text: string): Promise<OutMessage> {
    const { db } = this.d;
    const parsed = parseInvoiceDetails(text);
    if (!parsed) return catalogue.invoiceAskAgain();
    const pay = await db.selectFrom("payments").innerJoin("sessions", "sessions.id", "payments.session_id").select(["sessions.base_cents"]).where("payments.id", "=", pending.payment_id).executeTakeFirstOrThrow();
    // A full tax invoice (over R5 000) must name the buyer's address.
    if ((pay.base_cents ?? 0) > FULL_TAX_INVOICE_THRESHOLD_CENTS && !parsed.address) return catalogue.invoiceNeedAddress();

    const now = this.now();
    const out = await db.transaction().execute(async (trx) => {
      const already = await trx.selectFrom("tax_invoices").select(["number", "token"]).where("payment_id", "=", pending.payment_id).where("status", "=", "issued").executeTakeFirst();
      if (already) return already;
      // Per-merchant gapless sequence: the row lock serialises concurrent issues.
      const m = await trx
        .updateTable("merchants")
        .set({ invoice_seq: sql`invoice_seq + 1` })
        .where("id", "=", pending.merchant_id)
        .returning(["invoice_seq"])
        .executeTakeFirstOrThrow();
      const number = `INV-${String(m.invoice_seq).padStart(6, "0")}`;
      const token = newUrlToken();
      const r = await trx
        .updateTable("tax_invoices")
        .set({ status: "issued", number, token, buyer_name: parsed.name, buyer_vat: parsed.vat, buyer_address: parsed.address, issued_at: now })
        .where("id", "=", pending.id)
        .where("status", "=", "awaiting_details")
        .executeTakeFirst();
      if (r.numUpdatedRows !== 1n) throw new Error("invoice request changed underneath us");
      await audit(trx, { merchantId: pending.merchant_id, actorKind: "system", actorId: null, action: "tax_invoice.issued", entity: "payment", entityId: pending.payment_id, detail: { number } });
      return { number, token };
    });
    const merchant = await db.selectFrom("merchants").select("name").where("id", "=", pending.merchant_id).executeTakeFirstOrThrow();
    return catalogue.invoiceReady({ merchant: merchant.name, number: out.number!, url: this.url(out.token!) });
  }

  /** The PDF behind /i/:token. */
  async pdf(token: string): Promise<{ number: string; body: Buffer } | null> {
    const { db, config } = this.d;
    const r = await db
      .selectFrom("tax_invoices")
      .innerJoin("payments", "payments.id", "tax_invoices.payment_id")
      .innerJoin("sessions", "sessions.id", "payments.session_id")
      .innerJoin("merchants", "merchants.id", "tax_invoices.merchant_id")
      .innerJoin("receipts", "receipts.payment_id", "payments.id")
      .leftJoin("bills", "bills.id", "sessions.bill_id")
      .leftJoin("bill_shares", "bill_shares.id", "sessions.bill_share_id")
      .select([
        "tax_invoices.number",
        "tax_invoices.buyer_name",
        "tax_invoices.buyer_vat",
        "tax_invoices.buyer_address",
        "tax_invoices.issued_at",
        "payments.amount_cents",
        "payments.refunded_cents",
        "payments.paid_at",
        "sessions.base_cents",
        "sessions.tip_cents",
        "merchants.name",
        "merchants.trading_name",
        "merchants.vat_number",
        "merchants.address",
        "receipts.number as receiptNumber",
        "bills.lines",
        "bill_shares.label as shareLabel",
      ])
      .where("tax_invoices.token", "=", token)
      .where("tax_invoices.status", "=", "issued")
      .executeTakeFirst();
    if (!r) return null;
    const base = r.base_cents ?? 0;
    const lines = r.shareLabel || !r.lines?.length ? [{ description: r.shareLabel ?? "Amount", amount: cents(base) }] : r.lines.map((l) => ({ description: l.quantity && l.quantity > 1 ? `${l.description} x${l.quantity}` : l.description, amount: cents(l.amountCents * (l.quantity ?? 1)) }));
    const body = await renderTaxInvoicePdf({
      number: r.number!,
      issuedAt: r.issued_at!,
      supplyDate: r.paid_at!,
      seller: { name: r.name, tradingName: r.trading_name, vatNumber: r.vat_number ?? "", address: r.address ?? "" },
      buyer: { name: r.buyer_name!, vatNumber: r.buyer_vat!, address: r.buyer_address },
      lines,
      inclusive: cents(base),
      vat: vatIncluded(cents(base)),
      tip: cents(r.tip_cents),
      total: cents(r.amount_cents),
      receiptNumber: r.receiptNumber,
      refunded: cents(r.refunded_cents),
      product: config.PRODUCT_NAME,
    });
    return { number: r.number!, body };
  }
}
