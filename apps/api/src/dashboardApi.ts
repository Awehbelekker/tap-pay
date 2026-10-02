import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { newUrlToken, normaliseVatNumber, type Clock } from "@tappay/core";
import type { Config } from "@tappay/config";
import { audit, normaliseMsisdn, type Crypto, type Database, type Kysely } from "@tappay/db";
import { requireStaff, type Auth, type Staff } from "./auth.js";
import { parseRange, ReportError, type Reports } from "./reports.js";

/**
 * Manager dashboard endpoints (SPEC 16): business and VAT details for slips and tax invoices,
 * services and prices, staff, receipt links (revoke or reissue), reports and CSV export.
 * Tenant scope on every query; managers only, except reports, which staff see for themselves.
 */

export interface DashboardApiDeps {
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  auth: Auth;
  clock: Clock;
  reports: Reports;
}

const uuid = z.string().uuid();
const isManager = (s: Staff) => s.role === "manager" || s.role === "owner";

function bad(reply: FastifyReply, err: z.ZodError) {
  return reply.code(422).send({ code: "invalid", message: "check the fields", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}
const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ code: "not_found", message: `${what} not found` });

export function registerDashboardApi(app: FastifyInstance, d: DashboardApiDeps): void {
  const { db, crypto, config } = d;
  const staff = requireStaff(d.auth);
  const manager = requireStaff(d.auth, ["owner", "manager"]);
  const me = (req: FastifyRequest) => req.staff!;

  // ── Business details (slips, tax invoices) ─────────────────────────────────

  app.get("/v1/merchant/business", { preHandler: manager }, async (req) => {
    const m = await db.selectFrom("merchants").select(["name", "trading_name", "vat_registered", "vat_number", "address"]).where("id", "=", me(req).merchantId).executeTakeFirstOrThrow();
    return { name: m.name, tradingName: m.trading_name, vatRegistered: m.vat_registered, vatNumber: m.vat_number, address: m.address };
  });

  app.patch("/v1/merchant/business", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const b = z
      .object({
        name: z.string().trim().min(2).max(120),
        tradingName: z.string().trim().max(120).nullable(),
        vatRegistered: z.boolean(),
        vatNumber: z.string().trim().max(20).nullable(),
        address: z.string().trim().max(300).nullable(),
      })
      .partial()
      .strict()
      .safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const cur = await db.selectFrom("merchants").select(["vat_registered", "vat_number", "address"]).where("id", "=", s.merchantId).executeTakeFirstOrThrow();
    const v = b.data;
    let vatNumber = v.vatNumber === undefined ? cur.vat_number : v.vatNumber;
    if (vatNumber) {
      vatNumber = normaliseVatNumber(vatNumber);
      if (!vatNumber) return reply.code(422).send({ code: "bad_vat_number", message: "a VAT number is 10 digits starting with 4" });
    }
    const address = v.address === undefined ? cur.address : v.address || null;
    const registered = v.vatRegistered ?? cur.vat_registered;
    // A tax invoice must show the seller's VAT number and address (SPEC 14).
    if (registered && (!vatNumber || !address)) return reply.code(422).send({ code: "vat_details_needed", message: "a VAT-registered business needs its VAT number and address" });
    await db
      .updateTable("merchants")
      .set({
        ...(v.name !== undefined && { name: v.name }),
        ...(v.tradingName !== undefined && { trading_name: v.tradingName || null }),
        vat_registered: registered,
        vat_number: vatNumber,
        address,
      })
      .where("id", "=", s.merchantId)
      .execute();
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "business.changed", entity: "merchant", entityId: s.merchantId, detail: { fields: Object.keys(v) } });
    return reply.send({ ok: true });
  });

  // ── Services and prices ─────────────────────────────────────────────────────

  app.get("/v1/merchant/services/all", { preHandler: manager }, async (req) => {
    const rows = await db.selectFrom("services").select(["id", "name", "price_cents", "active", "reminders_enabled"]).where("merchant_id", "=", me(req).merchantId).orderBy("active", "desc").orderBy("name").execute();
    return { items: rows.map((r) => ({ id: r.id, name: r.name, priceCents: r.price_cents, active: r.active, remindersEnabled: r.reminders_enabled })) };
  });

  const service = z.object({ name: z.string().trim().min(1).max(60), priceCents: z.number().int().min(0).max(100_000_000), active: z.boolean(), remindersEnabled: z.boolean() });

  app.post("/v1/merchant/services", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const b = service.omit({ active: true, remindersEnabled: true }).strict().safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const r = await db.insertInto("services").values({ merchant_id: s.merchantId, name: b.data.name, price_cents: b.data.priceCents }).returning("id").executeTakeFirstOrThrow();
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "service.created", entity: "service", entityId: r.id, detail: b.data });
    return reply.code(201).send({ id: r.id });
  });

  /** Price changes apply to new bills; bills already made keep their price. */
  app.patch<{ Params: { id: string } }>("/v1/merchant/services/:id", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    if (!uuid.safeParse(req.params.id).success) return notFound(reply, "service");
    const b = service.partial().strict().safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    if (Object.keys(b.data).length === 0) return reply.code(422).send({ code: "empty", message: "nothing to change" });
    const r = await db
      .updateTable("services")
      .set({
        ...(b.data.name !== undefined && { name: b.data.name }),
        ...(b.data.priceCents !== undefined && { price_cents: b.data.priceCents }),
        ...(b.data.active !== undefined && { active: b.data.active }),
        ...(b.data.remindersEnabled !== undefined && { reminders_enabled: b.data.remindersEnabled }),
      })
      .where("merchant_id", "=", s.merchantId)
      .where("id", "=", req.params.id)
      .executeTakeFirst();
    if (r.numUpdatedRows !== 1n) return notFound(reply, "service");
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "service.changed", entity: "service", entityId: req.params.id, detail: b.data });
    return reply.send({ ok: true });
  });

  // ── Staff ─────────────────────────────────────────────────────────────────

  /**
   * Add a staff member by WhatsApp number. They sign in with a WhatsApp code; nothing is sent
   * until they ask for one. Only an owner can add another owner.
   */
  app.post("/v1/merchant/staff", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const b = z.object({ name: z.string().trim().min(1).max(60), msisdn: z.string().trim().min(9).max(20), role: z.enum(["staff", "manager", "owner"]).default("staff") }).strict().safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    if (b.data.role === "owner" && s.role !== "owner") return reply.code(403).send({ code: "forbidden", message: "only an owner can add an owner" });
    const msisdn = normaliseMsisdn(b.data.msisdn);
    if (!/^27\d{9}$/.test(msisdn)) return reply.code(422).send({ code: "bad_number", message: "enter a South African mobile number" });
    const r = await db
      .insertInto("users")
      .values({ merchant_id: s.merchantId, display_name: b.data.name, role: b.data.role, msisdn_enc: crypto.encrypt(msisdn), msisdn_hash: crypto.lookupHash(msisdn), pin_hash: null })
      .onConflict((oc) => oc.columns(["merchant_id", "msisdn_hash"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!r) return reply.code(409).send({ code: "exists", message: "that number is already on your staff list" });
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "staff.added", entity: "user", entityId: r.id, detail: { role: b.data.role } });
    return reply.code(201).send({ id: r.id });
  });

  /** Rename, change role, or deactivate (sign-in and live sessions end at once, M4). */
  app.patch<{ Params: { id: string } }>("/v1/merchant/staff/:id", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    if (!uuid.safeParse(req.params.id).success) return notFound(reply, "staff member");
    const b = z.object({ name: z.string().trim().min(1).max(60), role: z.enum(["staff", "manager", "owner"]), active: z.boolean() }).partial().strict().safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    if (Object.keys(b.data).length === 0) return reply.code(422).send({ code: "empty", message: "nothing to change" });
    if (req.params.id === s.userId && (b.data.active === false || (b.data.role && b.data.role !== s.role))) return reply.code(409).send({ code: "self", message: "you cannot deactivate yourself or change your own role" });
    const target = await db.selectFrom("users").select("role").where("merchant_id", "=", s.merchantId).where("id", "=", req.params.id).executeTakeFirst();
    if (!target) return notFound(reply, "staff member");
    if ((target.role === "owner" || b.data.role === "owner") && s.role !== "owner") return reply.code(403).send({ code: "forbidden", message: "only an owner can change an owner" });
    await db
      .updateTable("users")
      .set({ ...(b.data.name !== undefined && { display_name: b.data.name }), ...(b.data.role !== undefined && { role: b.data.role }), ...(b.data.active !== undefined && { active: b.data.active }) })
      .where("merchant_id", "=", s.merchantId)
      .where("id", "=", req.params.id)
      .execute();
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "staff.changed", entity: "user", entityId: req.params.id, detail: b.data });
    return reply.send({ ok: true });
  });

  // ── Receipt links ─────────────────────────────────────────────────────────

  /**
   * Revoke a receipt link (sent to the wrong person, shared too widely), or reissue it under a
   * new token: the old link stops working either way.
   */
  app.post<{ Params: { id: string } }>("/v1/merchant/payments/:id/receipt", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    if (!uuid.safeParse(req.params.id).success) return notFound(reply, "receipt");
    const b = z.object({ action: z.enum(["revoke", "reissue"]) }).strict().safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const now = d.clock.now();
    const token = b.data.action === "reissue" ? newUrlToken() : null;
    const r = await db
      .updateTable("receipts")
      .set(token ? { receipt_token: token, revoked_at: null } : { revoked_at: now })
      .where("merchant_id", "=", s.merchantId)
      .where("payment_id", "=", req.params.id)
      .executeTakeFirst();
    if (r.numUpdatedRows !== 1n) return notFound(reply, "receipt");
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: `receipt.${b.data.action}d`, entity: "payment", entityId: req.params.id });
    return reply.send({ receiptUrl: token ? `${config.PUBLIC_API_URL}/r/${token}` : null });
  });

  // ── Reports ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/merchant/reports/summary", { preHandler: staff }, async (req, reply) => {
    const s = me(req);
    try {
      return await d.reports.summary(s.merchantId, parseRange(req.query, d.clock.now()), isManager(s) ? null : s.userId);
    } catch (e) {
      if (e instanceof ReportError) return reply.code(422).send({ code: "bad_range", message: e.message });
      throw e;
    }
  });

  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/merchant/reports/export.csv", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    let range;
    try {
      range = parseRange(req.query, d.clock.now());
    } catch (e) {
      if (e instanceof ReportError) return reply.code(422).send({ code: "bad_range", message: e.message });
      throw e;
    }
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "report.exported", entity: "merchant", entityId: s.merchantId, detail: { ...range } });
    return reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", `attachment; filename="payments-${range.from}-to-${range.to}.csv"`)
      .type("text/csv; charset=utf-8")
      .send(`\ufeff${await d.reports.csv(s.merchantId, range)}`);
  });

}
