import { sql, type Kysely, type Transaction } from "kysely";
import {
  ACTIVE_SESSION_STATES,
  nextBill,
  nextSession,
  nextShare,
  type ShareEvent,
  type ShareState,
  type BillEvent,
  type BillState,
  type Posting,
  type SessionEvent,
  type SessionState,
} from "@tappay/core";
import type { Crypto } from "./crypto.js";
import type { BillLine, Database } from "./db.js";

/**
 * Repositories for the pay flow. All writes that change a bill or session status go through
 * `transitionBill` / `transitionSession`, which compute the target with the pure state machine
 * and apply it with a compare-and-set on the current status, so concurrent handlers can never
 * both win. Merchant-facing reads take a merchantId (tenant scope).
 */

export type Db = Kysely<Database> | Transaction<Database>;

// ── Tags ─────────────────────────────────────────────────────────────────────

export async function findTagForTap(db: Db, by: { code: string } | { id: string }) {
  const q = db
    .selectFrom("tags")
    .innerJoin("merchants", "merchants.id", "tags.merchant_id")
    .leftJoin("users", (j) => j.onRef("users.id", "=", "tags.assigned_user_id").on("users.active", "=", true))
    .select([
      "tags.id as tagId",
      "tags.kind",
      "tags.status as tagStatus",
      "tags.assigned_user_id as staffUserId",
      "users.display_name as staffName",
      "merchants.id as merchantId",
      "merchants.name as merchantName",
      "merchants.status as merchantStatus",
      "merchants.tips_enabled as tipsEnabled",
      "merchants.tip_presets as tipPresets",
      "merchants.mode",
      "merchants.no_bill_action as noBillAction",
      "merchants.quick_tip_presets_cents as quickTipPresets",
      "merchants.quick_tip_min_cents as quickTipMin",
      "merchants.quick_tip_max_cents as quickTipMax",
      "merchants.open_amount_max_cents as openAmountMax",
      "merchants.tip_min_cents as tipMin",
      "merchants.tip_max_bp as tipMaxBp",
      "merchants.tip_max_cents as tipMaxCents",
    ]);
  return ("code" in by ? q.where("tags.code", "=", by.code) : q.where("tags.id", "=", by.id)).executeTakeFirst();
}

// ── Claim tokens ─────────────────────────────────────────────────────────────

export async function insertClaimToken(db: Db, i: { hash: Buffer; tagId: string | null; billId?: string | null; merchantId: string; expiresAt: Date }) {
  await db.insertInto("claim_tokens").values({ token_hash: i.hash, tag_id: i.tagId, merchant_id: i.merchantId, bill_id: i.billId ?? null, expires_at: i.expiresAt, used_at: null }).execute();
}

/** Single use: the first caller to consume a live token gets it; everyone else gets null. */
export async function consumeClaimToken(db: Db, hash: Buffer, now: Date) {
  return db
    .updateTable("claim_tokens")
    .set({ used_at: now })
    .where("token_hash", "=", hash)
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .returning(["tag_id as tagId", "bill_id as billId", "merchant_id as merchantId"])
    .executeTakeFirst();
}

// ── Customers ────────────────────────────────────────────────────────────────

export async function upsertCustomer(db: Db, crypto: Crypto, msisdn: string, profileName: string | null): Promise<string> {
  const r = await db
    .insertInto("customers")
    .values({ msisdn_hash: crypto.lookupHash(msisdn), msisdn_enc: crypto.encrypt(msisdn), profile_name: profileName, opted_out_at: null })
    .onConflict((oc) => oc.column("msisdn_hash").doUpdateSet({ profile_name: (eb) => eb.ref("excluded.profile_name") }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return r.id;
}

export async function customerMsisdn(db: Db, crypto: Crypto, customerId: string): Promise<string | null> {
  const r = await db.selectFrom("customers").select("msisdn_enc").where("id", "=", customerId).executeTakeFirst();
  return r ? crypto.decrypt(r.msisdn_enc) : null;
}

export async function optOutGlobally(db: Db, customerId: string, now: Date) {
  await sql`insert into opt_outs (customer_id, merchant_id) values (${customerId}, null) on conflict do nothing`.execute(db);
  await db.updateTable("customers").set({ opted_out_at: now }).where("id", "=", customerId).execute();
}

// ── Bills ────────────────────────────────────────────────────────────────────

export function linesTotal(lines: BillLine[]): number {
  return lines.reduce((a, l) => a + l.amountCents * (l.quantity ?? 1), 0);
}

/**
 * Create a bill. With `shares`, the share amounts must sum to the lines total (checked here
 * and inside one transaction with the bill insert when a transaction is passed in).
 */
export async function createBill(
  db: Db,
  i: {
    merchantId: string;
    tagId: string | null;
    assignedUserId: string | null;
    createdBy: string | null;
    lines: BillLine[];
    billToken: string;
    expiresAt: Date;
    type?: "fixed" | "open" | "quick_tip";
    intendedMsisdn?: { hash: Buffer; enc: Buffer } | null;
    billCode?: string | null;
    tableLabel?: string | null;
    shares?: { label: string; amountCents: number }[];
  },
) {
  const subtotal = linesTotal(i.lines);
  if (i.shares && i.shares.reduce((a, x) => a + x.amountCents, 0) !== subtotal) {
    throw new Error("shares must sum to the bill total");
  }
  const bill = await db
    .insertInto("bills")
    .values({
      merchant_id: i.merchantId,
      tag_id: i.tagId,
      assigned_user_id: i.assignedUserId,
      created_by: i.createdBy,
      type: i.type ?? "fixed",
      lines: JSON.stringify(i.lines),
      subtotal_cents: subtotal,
      bill_token: i.billToken,
      expires_at: i.expiresAt,
      intended_msisdn_hash: i.intendedMsisdn?.hash ?? null,
      intended_msisdn_enc: i.intendedMsisdn?.enc ?? null,
      reference: null,
      table_label: i.tableLabel ?? null,
      bill_code: i.billCode ?? null,
      customer_id: null,
      claimed_at: null,
      paid_at: null,
      shift_id: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (i.shares?.length) {
    await db
      .insertInto("bill_shares")
      .values(i.shares.map((x) => ({ bill_id: bill.id, merchant_id: i.merchantId, label: x.label, amount_cents: x.amountCents, customer_id: null, claimed_at: null })))
      .execute();
  }
  return bill;
}

const BILL_COLS = [
  "bills.id",
  "bills.merchant_id",
  "bills.type",
  "bills.tag_id",
  "bills.bill_code",
  "bills.bill_token",
  "bills.status",
  "bills.customer_id",
  "bills.subtotal_cents",
  "bills.lines",
  "bills.assigned_user_id",
  "bills.intended_msisdn_hash",
  "bills.expires_at",
  "bills.version",
] as const;

/** Live (not terminal, not expired) bills on a tag that this customer could be paying. */
export async function liveBillsOnTag(db: Db, merchantId: string, tagId: string, now: Date) {
  return db
    .selectFrom("bills")
    .select(BILL_COLS)
    .select((eb) =>
      eb.exists(eb.selectFrom("bill_shares").select("bill_shares.id").whereRef("bill_shares.bill_id", "=", "bills.id")).as("has_shares"),
    )
    .where("bills.merchant_id", "=", merchantId)
    .where("bills.tag_id", "=", tagId)
    .where("bills.status", "in", ["open", "claimed"])
    .where("bills.expires_at", ">", now)
    .orderBy("bills.created_at", "asc")
    .execute();
}

/** The receipt token for a bill on this tag that this customer paid since `since`. */
export async function recentlyPaidOnTag(db: Db, merchantId: string, tagId: string, customerId: string, since: Date) {
  const r = await db
    .selectFrom("bills")
    .innerJoin("sessions", "sessions.bill_id", "bills.id")
    .innerJoin("payments", "payments.session_id", "sessions.id")
    .innerJoin("receipts", "receipts.payment_id", "payments.id")
    .select(["bills.id", "receipts.receipt_token as receiptToken"])
    .where("bills.merchant_id", "=", merchantId)
    .where("bills.tag_id", "=", tagId)
    .where("bills.status", "=", "paid")
    .where("sessions.customer_id", "=", customerId)
    .where("payments.status", "=", "succeeded")
    .where("bills.paid_at", ">", since)
    .orderBy("bills.paid_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return r ?? null;
}

export async function billByToken(db: Db, billToken: string) {
  return db.selectFrom("bills").select(BILL_COLS).where("bills.bill_token", "=", billToken).executeTakeFirst();
}

/** An open bill on the tag, addressed to some other number, whose 4-digit code matches. */
export async function openBillByCode(db: Db, merchantId: string, tagId: string, code: string, now: Date) {
  return db
    .selectFrom("bills")
    .select(BILL_COLS)
    .where("bills.merchant_id", "=", merchantId)
    .where("bills.tag_id", "=", tagId)
    .where("bills.status", "=", "open")
    .where("bills.bill_code", "=", code)
    .where("bills.intended_msisdn_hash", "is not", null)
    .where("bills.expires_at", ">", now)
    .executeTakeFirst();
}

/** Set a bill's lines and subtotal (open-amount entry, merchant edit). Bumps the version. */
export async function setBillLines(db: Db, merchantId: string, billId: string, lines: BillLine[]): Promise<boolean> {
  const r = await db
    .updateTable("bills")
    .set({ lines: JSON.stringify(lines), subtotal_cents: linesTotal(lines), version: sql`version + 1` })
    .where("merchant_id", "=", merchantId)
    .where("id", "=", billId)
    .where("status", "in", ["open", "claimed"])
    .executeTakeFirst();
  return r.numUpdatedRows === 1n;
}

export async function getBill(db: Db, merchantId: string, billId: string) {
  return db.selectFrom("bills").select(BILL_COLS).where("bills.merchant_id", "=", merchantId).where("bills.id", "=", billId).executeTakeFirst();
}

/**
 * Compare-and-set transition. Returns false if the bill was not in `from` any more (another
 * handler won); throws IllegalTransition if `from --event-->` is not allowed at all.
 */
export async function transitionBill(
  db: Db,
  billId: string,
  from: BillState,
  event: BillEvent,
  patch: { customer_id?: string | null; claimed_at?: Date | null; paid_at?: Date | null } = {},
): Promise<boolean> {
  const to = nextBill(from, event);
  const r = await db
    .updateTable("bills")
    .set({ ...patch, status: to, version: sql`version + 1` })
    .where("id", "=", billId)
    .where("status", "=", from)
    .executeTakeFirst();
  return r.numUpdatedRows === 1n;
}

// ── Shares ───────────────────────────────────────────────────────────────────

export async function listShares(db: Db, billId: string) {
  return db
    .selectFrom("bill_shares")
    .select(["id", "label", "amount_cents", "status", "customer_id"])
    .where("bill_id", "=", billId)
    .orderBy("label", "asc")
    .orderBy("id", "asc")
    .execute();
}

export async function getShare(db: Db, shareId: string) {
  return db.selectFrom("bill_shares").select(["id", "bill_id", "merchant_id", "label", "amount_cents", "status", "customer_id"]).where("id", "=", shareId).executeTakeFirst();
}

export async function transitionShare(
  db: Db,
  shareId: string,
  from: ShareState,
  event: ShareEvent,
  patch: { customer_id?: string | null; claimed_at?: Date | null } = {},
): Promise<boolean> {
  const to = nextShare(from, event);
  const r = await db
    .updateTable("bill_shares")
    .set({ ...patch, status: to, version: sql`version + 1` })
    .where("id", "=", shareId)
    .where("status", "=", from)
    .executeTakeFirst();
  return r.numUpdatedRows === 1n;
}

export async function unpaidShareCount(db: Db, billId: string): Promise<number> {
  const r = await db
    .selectFrom("bill_shares")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("bill_id", "=", billId)
    .where("status", "in", ["open", "claimed"])
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

// ── Bill code prompts ────────────────────────────────────────────────────────

export async function getCodePrompt(db: Db, customerId: string, tagId: string) {
  return db.selectFrom("bill_code_prompts").selectAll().where("customer_id", "=", customerId).where("tag_id", "=", tagId).executeTakeFirst();
}

/** The tag this customer was most recently asked a bill code for, if still awaiting. */
export async function awaitingCodePrompt(db: Db, customerId: string, now: Date) {
  return db
    .selectFrom("bill_code_prompts")
    .selectAll()
    .where("customer_id", "=", customerId)
    .where("awaiting_until", ">", now)
    .orderBy("updated_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

export async function setCodePrompt(
  db: Db,
  i: { customerId: string; tagId: string; merchantId: string; failures: number; awaitingUntil: Date | null; lockedUntil: Date | null },
) {
  await db
    .insertInto("bill_code_prompts")
    .values({ customer_id: i.customerId, tag_id: i.tagId, merchant_id: i.merchantId, failures: i.failures, awaiting_until: i.awaitingUntil, locked_until: i.lockedUntil })
    .onConflict((oc) =>
      oc.columns(["customer_id", "tag_id"]).doUpdateSet({ failures: i.failures, awaiting_until: i.awaitingUntil, locked_until: i.lockedUntil, updated_at: new Date() }),
    )
    .execute();
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(
  db: Db,
  i: {
    merchantId: string;
    billId: string;
    shareId?: string | null;
    customerId: string;
    status: SessionState;
    base: number;
    tip: number;
    expiresAt: Date;
    waWindowExpiresAt: Date;
  },
) {
  return db
    .insertInto("sessions")
    .values({
      merchant_id: i.merchantId,
      bill_id: i.billId,
      bill_share_id: i.shareId ?? null,
      customer_id: i.customerId,
      status: i.status,
      base_cents: i.base,
      tip_cents: i.tip,
      expires_at: i.expiresAt,
      wa_window_expires_at: i.waWindowExpiresAt,
    })
    .returning(["id", "version"])
    .executeTakeFirstOrThrow();
}

export async function transitionSession(
  db: Db,
  sessionId: string,
  from: SessionState,
  event: SessionEvent,
  patch: { base_cents?: number; tip_cents?: number; expires_at?: Date; wa_window_expires_at?: Date } = {},
): Promise<boolean> {
  const to = nextSession(from, event);
  const r = await db
    .updateTable("sessions")
    .set({ ...patch, status: to, version: sql`version + 1` })
    .where("id", "=", sessionId)
    .where("status", "=", from)
    .executeTakeFirst();
  return r.numUpdatedRows === 1n;
}

/** The customer's most recent session that is still in progress (any merchant). */
export async function latestActiveSession(db: Db, customerId: string) {
  return db
    .selectFrom("sessions")
    .innerJoin("merchants", "merchants.id", "sessions.merchant_id")
    .leftJoin("bills", "bills.id", "sessions.bill_id")
    .leftJoin("bill_shares", "bill_shares.id", "sessions.bill_share_id")
    .leftJoin("users", "users.id", "bills.assigned_user_id")
    .select([
      "sessions.id",
      "sessions.merchant_id as merchantId",
      "sessions.bill_id as billId",
      "sessions.bill_share_id as shareId",
      "bill_shares.label as shareLabel",
      "bills.type as billType",
      "merchants.quick_tip_presets_cents as quickTipPresets",
      "merchants.quick_tip_min_cents as quickTipMin",
      "merchants.quick_tip_max_cents as quickTipMax",
      "merchants.open_amount_max_cents as openAmountMax",
      "merchants.tip_min_cents as tipMin",
      "merchants.tip_max_bp as tipMaxBp",
      "merchants.tip_max_cents as tipMaxCents",
      "sessions.status",
      "sessions.base_cents as base",
      "sessions.tip_cents as tip",
      "sessions.expires_at as expiresAt",
      "sessions.version",
      "merchants.name as merchantName",
      "merchants.tips_enabled as tipsEnabled",
      "merchants.tip_presets as tipPresets",
      "bills.lines as lines",
      "bills.status as billStatus",
      "users.display_name as staffName",
    ])
    .where("sessions.customer_id", "=", customerId)
    .where("sessions.status", "in", [...ACTIVE_SESSION_STATES, "failed"])
    .orderBy("sessions.created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

/** Every in-progress session on a bill, for merchant release, edit and cancel. */
export async function activeSessionsOnBill(db: Db, merchantId: string, billId: string) {
  return db
    .selectFrom("sessions")
    .select(["id", "status", "customer_id as customerId", "bill_share_id as shareId"])
    .where("merchant_id", "=", merchantId)
    .where("bill_id", "=", billId)
    .where("status", "in", ACTIVE_SESSION_STATES)
    .execute();
}

export async function activeSessionOnBill(db: Db, billId: string, customerId: string) {
  return db
    .selectFrom("sessions")
    .select(["id", "status", "version"])
    .where("bill_id", "=", billId)
    .where("customer_id", "=", customerId)
    .where("status", "in", ACTIVE_SESSION_STATES)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

// ── Payments, ledger, receipts ───────────────────────────────────────────────

export async function insertPendingPayment(
  db: Db,
  i: { merchantId: string; sessionId: string; provider: string; providerRef: string; idempotencyKey: string; amount: number; checkoutUrl: string; checkoutExpiresAt: Date },
) {
  await db
    .insertInto("payments")
    .values({
      merchant_id: i.merchantId,
      session_id: i.sessionId,
      provider: i.provider,
      provider_ref: i.providerRef,
      idempotency_key: i.idempotencyKey,
      amount_cents: i.amount,
      method: null,
      provider_fee_cents: null,
      raw: JSON.stringify({ checkoutUrl: i.checkoutUrl, checkoutExpiresAt: i.checkoutExpiresAt.toISOString() }),
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .execute();
}

export async function pendingPaymentForSession(db: Db, sessionId: string) {
  return db
    .selectFrom("payments")
    .select(["id", "provider_ref", "raw", "amount_cents"])
    .where("session_id", "=", sessionId)
    .where("status", "=", "pending")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

/** Locks the payment row for the rest of the transaction. */
export async function lockPaymentByProviderRef(trx: Transaction<Database>, provider: string, providerRef: string) {
  return trx
    .selectFrom("payments")
    .innerJoin("sessions", "sessions.id", "payments.session_id")
    .select([
      "payments.id",
      "payments.merchant_id as merchantId",
      "payments.session_id as sessionId",
      "payments.amount_cents as amount",
      "payments.status",
      "sessions.status as sessionStatus",
      "sessions.base_cents as base",
      "sessions.tip_cents as tip",
      "sessions.bill_id as billId",
      "sessions.bill_share_id as shareId",
      "sessions.customer_id as customerId",
    ])
    .where("payments.provider", "=", provider)
    .where("payments.provider_ref", "=", providerRef)
    .forUpdate("payments")
    .executeTakeFirst();
}

export async function settlePayment(
  db: Db,
  paymentId: string,
  i: { status: "succeeded" | "failed" | "cancelled"; method: string | null; fee: number | null },
): Promise<boolean> {
  const r = await db
    .updateTable("payments")
    .set({ status: i.status, method: i.method, provider_fee_cents: i.fee, updated_at: new Date() })
    .where("id", "=", paymentId)
    // Success may arrive after a failure/cancel notice for the same checkout; nothing else moves.
    .where("status", "in", i.status === "succeeded" ? ["pending", "failed", "cancelled"] : ["pending"])
    .executeTakeFirst();
  return r.numUpdatedRows === 1n;
}

export async function insertPostings(db: Db, merchantId: string, paymentId: string, postings: Posting[]) {
  if (postings.length === 0) return;
  await db
    .insertInto("ledger_entries")
    .values(
      postings.map((p) => ({
        merchant_id: merchantId,
        payment_id: paymentId,
        payout_id: null,
        kind: p.kind,
        party_kind: p.partyKind,
        party_user_id: p.partyUserId,
        amount_cents: p.amount,
        note: null,
      })),
    )
    .execute();
}

export async function createReceipt(db: Db, i: { merchantId: string; paymentId: string; token: string; number: string }) {
  await db.insertInto("receipts").values({ merchant_id: i.merchantId, payment_id: i.paymentId, receipt_token: i.token, number: i.number, image_key: null }).execute();
}

export async function receiptByPayment(db: Db, paymentId: string) {
  return db.selectFrom("receipts").select(["receipt_token as token", "number"]).where("payment_id", "=", paymentId).executeTakeFirst();
}

/** Everything the slip needs, looked up by the unguessable receipt token. */
export async function receiptView(db: Db, token: string) {
  return db
    .selectFrom("receipts")
    .innerJoin("payments", "payments.id", "receipts.payment_id")
    .innerJoin("sessions", "sessions.id", "payments.session_id")
    .innerJoin("merchants", "merchants.id", "receipts.merchant_id")
    .leftJoin("bills", "bills.id", "sessions.bill_id")
    .leftJoin("bill_shares", "bill_shares.id", "sessions.bill_share_id")
    .leftJoin("users", "users.id", "bills.assigned_user_id")
    .select([
      "bills.type as billType",
      "bill_shares.label as shareLabel",
      "receipts.number",
      "payments.id as paymentId",
      "payments.amount_cents as total",
      "payments.method",
      "payments.updated_at as paidAt",
      "sessions.base_cents as base",
      "sessions.tip_cents as tip",
      "merchants.name as merchantName",
      "bills.lines as lines",
      "users.display_name as staffName",
    ])
    .where("receipts.receipt_token", "=", token)
    .executeTakeFirst();
}

// ── Webhook events, message log, audit ──────────────────────────────────────

/** Records an inbound event once. Returns the row id, or null if this event was already seen. */
export async function recordWebhookEvent(db: Db, i: { source: string; externalId: string; signatureOk: boolean; payload: unknown }) {
  const r = await db
    .insertInto("webhook_events")
    .values({ source: i.source, external_id: i.externalId, signature_ok: i.signatureOk, payload: JSON.stringify(i.payload), error: null, processed_at: null })
    .onConflict((oc) => oc.columns(["source", "external_id"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return r?.id ?? null;
}

export async function finishWebhookEvent(db: Db, id: string, status: "processed" | "failed" | "ignored", error?: string) {
  await db.updateTable("webhook_events").set({ status, error: error ?? null, processed_at: new Date() }).where("id", "=", id).execute();
}

export async function logMessage(
  db: Db,
  i: { customerId: string | null; merchantId: string | null; direction: "in" | "out"; waMessageId: string | null; kind: string; template?: string | null },
) {
  await db
    .insertInto("message_log")
    .values({ customer_id: i.customerId, merchant_id: i.merchantId, direction: i.direction, wa_message_id: i.waMessageId, kind: i.kind, template: i.template ?? null, status: null })
    .execute();
}

export async function audit(
  db: Db,
  i: { merchantId: string | null; actorKind: "user" | "operator" | "system" | "customer"; actorId: string | null; action: string; entity: string; entityId: string | null; detail?: Record<string, unknown> },
) {
  await db
    .insertInto("audit_log")
    .values({ merchant_id: i.merchantId, actor_kind: i.actorKind, actor_id: i.actorId, action: i.action, entity: i.entity, entity_id: i.entityId, detail: JSON.stringify(i.detail ?? {}) })
    .execute();
}
