import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "@tappay/config";
import {
  audit,
  latestMerchantEventId,
  listMerchantBills,
  maskMsisdn,
  merchantEventsSince,
  todaySummary,
  type BillLine,
  type Crypto,
  type Database,
  type Kysely,
  type MerchantEventRow,
} from "@tappay/db";
import type { Clock } from "@tappay/core";
import { Auth, AuthError, requireStaff, type Staff } from "./auth.js";
import { FlowError, type PayFlow } from "./flow.js";

/**
 * Staff auth and the merchant API (api/openapi.yaml "auth" and "merchant"). Every handler
 * scopes by the signed-in staff member's merchant; another merchant's ids simply are not found
 * (404). Staff see their own bills; managers and owners see the merchant's.
 */

export interface MerchantApiDeps {
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  auth: Auth;
  flow: PayFlow;
  clock: Clock;
  /** Subscribe to live events for one merchant (Postgres LISTEN fan-out). */
  subscribe(merchantId: string, fn: (id: number) => void): () => void;
  vapidPublicKey: string | null;
}

const msisdn = z.string().trim().min(8).max(20).regex(/^[+\d\s()-]+$/);
const uuid = z.string().uuid();
const line = z.object({ description: z.string().trim().min(1).max(80), amountCents: z.number().int().positive().max(100_000_000), quantity: z.number().int().min(1).max(100).optional() });

const billCreate = z
  .object({
    serviceId: uuid.optional(),
    lines: z.array(line).min(1).max(20).optional(),
    tagCode: z.string().trim().max(32).nullish(),
    customerMsisdn: msisdn.nullish(),
    tableLabel: z.string().trim().max(40).nullish(),
    shares: z.union([z.object({ equal: z.number().int().min(2).max(10) }), z.object({ amounts: z.array(z.object({ label: z.string().trim().min(1).max(24), amountCents: z.number().int().positive() })).min(2).max(10) })]).optional(),
  })
  .refine((b) => Boolean(b.serviceId) !== Boolean(b.lines), { message: "give either serviceId or lines" });

const isManager = (s: Staff) => s.role === "manager" || s.role === "owner";

function bad(reply: FastifyReply, err: z.ZodError) {
  return reply.code(422).send({ code: "invalid", message: "check the fields", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}

export function registerMerchantApi(app: FastifyInstance, d: MerchantApiDeps): void {
  const { db, auth, flow, crypto, config } = d;
  const staff = requireStaff(auth);
  const manager = requireStaff(auth, ["owner", "manager"]);
  const me = (req: FastifyRequest) => req.staff!;

  const authError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AuthError) return reply.code(e.status).send({ code: e.code, message: e.code.replaceAll("_", " "), details: e.details });
    throw e;
  };

  // ── Auth ─────────────────────────────────────────────────────────────────

  app.post("/v1/auth/otp/request", async (req, reply) => {
    const b = z.object({ msisdn }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    await auth.requestOtp(b.data.msisdn);
    return reply.code(202).send({ ok: true });
  });

  app.post("/v1/auth/otp/verify", async (req, reply) => {
    const b = z
      .object({ msisdn, code: z.string().trim(), pin: z.string().trim().optional(), merchantId: uuid.optional(), deviceLabel: z.string().max(60).optional() })
      .safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    try {
      return reply.send(await auth.verifyOtp(b.data));
    } catch (e) {
      return authError(reply, e);
    }
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const b = z.object({ msisdn, pin: z.string().trim(), deviceId: z.string() }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    try {
      return reply.send(await auth.login(b.data));
    } catch (e) {
      return authError(reply, e);
    }
  });

  app.post("/v1/auth/refresh", async (req, reply) => {
    const b = z.object({ refreshToken: z.string().min(20) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    try {
      return reply.send(await auth.refresh(b.data.refreshToken));
    } catch (e) {
      return authError(reply, e);
    }
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const b = z.object({ refreshToken: z.string().min(20) }).safeParse(req.body);
    if (b.success) await auth.logout(b.data.refreshToken);
    return reply.send({ ok: true });
  });

  // ── Who am I ─────────────────────────────────────────────────────────────

  app.get("/v1/merchant/me", { preHandler: staff }, async (req) => {
    const s = me(req);
    const u = await db.selectFrom("users").select(["id", "display_name", "role", "notify_mute"]).where("id", "=", s.userId).executeTakeFirstOrThrow();
    const m = await db
      .selectFrom("merchants")
      .select(["id", "name", "mode", "tips_enabled", "tip_presets", "notify_managers"])
      .where("id", "=", s.merchantId)
      .executeTakeFirstOrThrow();
    const tags = await db.selectFrom("tags").select(["code", "label"]).where("merchant_id", "=", s.merchantId).where("assigned_user_id", "=", s.userId).where("status", "=", "active").execute();
    return {
      user: { id: u.id, name: u.display_name, role: u.role, muted: u.notify_mute },
      merchant: { id: m.id, name: m.name, mode: m.mode, tipsEnabled: m.tips_enabled, tipPresets: m.tip_presets, notifyManagers: m.notify_managers },
      myTags: tags,
      vapidPublicKey: d.vapidPublicKey,
    };
  });

  // ── Services and today's totals ──────────────────────────────────────────

  app.get("/v1/merchant/services", { preHandler: staff }, async (req) => {
    const rows = await db.selectFrom("services").select(["id", "name", "price_cents"]).where("merchant_id", "=", me(req).merchantId).where("active", "=", true).orderBy("name").execute();
    return { items: rows.map((r) => ({ id: r.id, name: r.name, priceCents: r.price_cents })) };
  });

  app.get("/v1/merchant/reports/today", { preHandler: staff }, async (req) => {
    const s = me(req);
    return todaySummary(db, s.merchantId, isManager(s) ? null : s.userId, d.clock.now());
  });

  // ── Bills ────────────────────────────────────────────────────────────────

  const toBill = (r: Awaited<ReturnType<typeof listMerchantBills>>[number]) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    lines: r.lines,
    subtotalCents: r.subtotal_cents,
    tipCents: Number(r.tip_cents ?? 0),
    billCode: r.bill_code,
    link: `${config.PUBLIC_API_URL}/b/${r.bill_token}`,
    tagCode: r.tag_code,
    tableLabel: r.table_label,
    staffName: r.staff_name,
    hasShares: Boolean(r.has_shares),
    // Masked number and first name only (SPEC 13).
    maskedCustomer: r.customer_enc ? maskMsisdn(crypto.decrypt(r.customer_enc)) : null,
    customerName: r.customer_name?.trim().split(/\s+/)[0] ?? null,
    expiresAt: r.expires_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
    version: r.version,
  });

  const findBill = async (s: Staff, id: string) => {
    if (!uuid.safeParse(id).success) return undefined;
    const [row] = await listMerchantBills(db, { merchantId: s.merchantId, onlyUserId: isManager(s) ? null : s.userId, statuses: null, billId: id, limit: 1 });
    return row;
  };

  app.get<{ Querystring: { status?: string; limit?: string } }>("/v1/merchant/bills", { preHandler: staff }, async (req) => {
    const s = me(req);
    const statuses = req.query.status ? req.query.status.split(",").filter((x) => /^[a-z_]+$/.test(x)) : null;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = await listMerchantBills(db, { merchantId: s.merchantId, onlyUserId: isManager(s) ? null : s.userId, statuses, limit });
    return { items: rows.map(toBill) };
  });

  app.get<{ Params: { id: string } }>("/v1/merchant/bills/:id", { preHandler: staff }, async (req, reply) => {
    const row = await findBill(me(req), req.params.id);
    return row ? toBill(row) : reply.code(404).send({ code: "not_found", message: "bill not found" });
  });

  app.post("/v1/merchant/bills", { preHandler: staff }, async (req, reply) => {
    const s = me(req);
    const b = billCreate.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);

    // Idempotency-Key: a retried create (weak signal, double tap) returns the first result.
    const key = req.headers["idempotency-key"];
    const scopedKey = typeof key === "string" && key.length >= 8 && key.length <= 100 ? `${s.userId}:bills:${key}` : null;
    if (scopedKey) {
      const claimed = await db.insertInto("idempotency_keys").values({ key: scopedKey, scope: "POST /v1/merchant/bills", response: null }).onConflict((oc) => oc.column("key").doNothing()).returning("key").executeTakeFirst();
      if (!claimed) {
        const prev = await db.selectFrom("idempotency_keys").select("response").where("key", "=", scopedKey).executeTakeFirst();
        return prev?.response ? reply.code(201).send(prev.response) : reply.code(409).send({ code: "in_progress", message: "same request still in progress" });
      }
    }

    let lines: BillLine[] | undefined = b.data.lines;
    if (b.data.serviceId) {
      const svc = await db.selectFrom("services").select(["name", "price_cents"]).where("merchant_id", "=", s.merchantId).where("id", "=", b.data.serviceId).where("active", "=", true).executeTakeFirst();
      if (!svc) {
        if (scopedKey) await db.deleteFrom("idempotency_keys").where("key", "=", scopedKey).execute();
        return reply.code(404).send({ code: "not_found", message: "service not found" });
      }
      lines = [{ description: svc.name, amountCents: svc.price_cents, serviceId: b.data.serviceId }];
    }
    try {
      const created = await flow.createBill({
        merchantId: s.merchantId,
        createdBy: s.userId,
        tagCode: b.data.tagCode ?? null,
        lines: lines!,
        customerMsisdn: b.data.customerMsisdn ?? null,
        tableLabel: b.data.tableLabel ?? null,
        ...(b.data.shares ? { shares: b.data.shares } : {}),
      });
      const row = await findBill({ ...s, role: "owner" }, created.bill.id);
      const body = toBill(row!);
      if (scopedKey) await db.updateTable("idempotency_keys").set({ response: JSON.stringify(body) }).where("key", "=", scopedKey).execute();
      return reply.code(201).send(body);
    } catch (e) {
      if (scopedKey) await db.deleteFrom("idempotency_keys").where("key", "=", scopedKey).execute();
      if (e instanceof FlowError) return reply.code(e.code === "unknown_tag" ? 404 : 409).send({ code: e.code, message: e.message });
      // A tag can hold only one claimable bill at a time (SPEC 5 rule 3).
      if ((e as Error).message.includes("bills_one_claimable_per_tag")) return reply.code(409).send({ code: "tag_busy", message: "this tag already has an open bill" });
      throw e;
    }
  });

  const billAction = (name: "cancel" | "release") =>
    app.post<{ Params: { id: string } }>(`/v1/merchant/bills/:id/${name}`, { preHandler: staff }, async (req, reply) => {
      const s = me(req);
      if (!(await findBill(s, req.params.id))) return reply.code(404).send({ code: "not_found", message: "bill not found" });
      try {
        if (name === "cancel") await flow.cancelBill(s.merchantId, req.params.id, s.userId);
        else await flow.releaseBill(s.merchantId, req.params.id, s.userId);
      } catch (e) {
        if (e instanceof FlowError) return reply.code(409).send({ code: e.code, message: e.message });
        throw e;
      }
      return toBill((await findBill(s, req.params.id))!);
    });
  billAction("cancel");
  billAction("release");

  app.patch<{ Params: { id: string } }>("/v1/merchant/bills/:id", { preHandler: staff }, async (req, reply) => {
    const s = me(req);
    const b = z.object({ lines: z.array(line).min(1).max(20) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    if (!(await findBill(s, req.params.id))) return reply.code(404).send({ code: "not_found", message: "bill not found" });
    try {
      await flow.editBillLines(s.merchantId, req.params.id, b.data.lines, s.userId);
    } catch (e) {
      if (e instanceof FlowError) return reply.code(409).send({ code: e.code, message: e.message });
      throw e;
    }
    return toBill((await findBill(s, req.params.id))!);
  });

  // ── Tags (assign to a person, till or table) ──────────────────────────────

  app.get("/v1/merchant/tags", { preHandler: staff }, async (req) => {
    const s = me(req);
    let q = db
      .selectFrom("tags")
      .leftJoin("users", "users.id", "tags.assigned_user_id")
      .select(["tags.code", "tags.label", "tags.status", "tags.kind", "tags.assigned_user_id", "users.display_name"])
      .where("tags.merchant_id", "=", s.merchantId);
    if (!isManager(s)) q = q.where((eb) => eb.or([eb("tags.assigned_user_id", "=", s.userId), eb("tags.assigned_user_id", "is", null)]));
    const rows = await q.orderBy("tags.code").execute();
    return {
      items: rows.map((r) => ({ code: r.code, label: r.label, status: r.status, kind: r.kind, assignedUserId: r.assigned_user_id, assignedName: r.display_name, url: `${config.PUBLIC_API_URL.replace(/\/$/, "")}/t/${r.code}` })),
    };
  });

  // Manager assigns a tag the operator provisioned to this merchant (code read by Web NFC or typed).
  app.put<{ Params: { code: string } }>("/v1/merchant/tags/:code", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const b = z.object({ assignedUserId: uuid.nullable(), label: z.string().trim().max(40).nullish() }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const tag = await db.selectFrom("tags").select(["id", "status"]).where("merchant_id", "=", s.merchantId).where("code", "=", req.params.code.toUpperCase()).executeTakeFirst();
    if (!tag) return reply.code(404).send({ code: "not_found", message: "tag not found" });
    if (tag.status === "revoked" || tag.status === "lost") return reply.code(409).send({ code: "tag_inactive", message: "tag was revoked or lost" });
    if (b.data.assignedUserId) {
      const u = await db.selectFrom("users").select("id").where("merchant_id", "=", s.merchantId).where("id", "=", b.data.assignedUserId).where("active", "=", true).executeTakeFirst();
      if (!u) return reply.code(404).send({ code: "not_found", message: "staff member not found" });
    }
    await db
      .updateTable("tags")
      .set({ assigned_user_id: b.data.assignedUserId, label: b.data.label ?? null, status: "active" })
      .where("id", "=", tag.id)
      .execute();
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "tag.assigned", entity: "tag", entityId: tag.id, detail: { assignedUserId: b.data.assignedUserId } });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { code: string } }>("/v1/merchant/tags/:code/revoke", { preHandler: manager }, async (req, reply) => {
    const s = me(req);
    const r = await db.updateTable("tags").set({ status: "revoked" }).where("merchant_id", "=", s.merchantId).where("code", "=", req.params.code.toUpperCase()).executeTakeFirst();
    if (r.numUpdatedRows !== 1n) return reply.code(404).send({ code: "not_found", message: "tag not found" });
    await audit(db, { merchantId: s.merchantId, actorKind: "user", actorId: s.userId, action: "tag.revoked", entity: "tag", entityId: req.params.code });
    return reply.send({ ok: true });
  });

  // ── Staff list (managers) ─────────────────────────────────────────────────

  app.get("/v1/merchant/staff", { preHandler: manager }, async (req) => {
    const rows = await db.selectFrom("users").select(["id", "display_name", "role", "active", "msisdn_enc"]).where("merchant_id", "=", me(req).merchantId).orderBy("display_name").execute();
    return { items: rows.map((u) => ({ id: u.id, name: u.display_name, role: u.role, active: u.active, maskedNumber: maskMsisdn(crypto.decrypt(u.msisdn_enc)) })) };
  });

  // ── Devices and push ──────────────────────────────────────────────────────

  const pushSub = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });

  app.put("/v1/merchant/devices/current/push", { preHandler: staff }, async (req, reply) => {
    const b = z.object({ subscription: pushSub.nullable() }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const s = me(req);
    await db
      .updateTable("devices")
      .set({ push_subscription: b.data.subscription ? JSON.stringify(b.data.subscription) : null, last_seen_at: d.clock.now() })
      .where("id", "=", s.deviceId)
      .where("user_id", "=", s.userId)
      .execute();
    return reply.send({ ok: true });
  });

  app.put("/v1/merchant/me/settings", { preHandler: staff }, async (req, reply) => {
    const b = z.object({ muted: z.boolean() }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    await db.updateTable("users").set({ notify_mute: b.data.muted }).where("id", "=", me(req).userId).execute();
    return reply.send({ ok: true });
  });

  // ── Live events (SSE) ─────────────────────────────────────────────────────

  // Staff see events for bills assigned to them or created by them; managers see everything.
  const visible = (s: Staff, e: MerchantEventRow) => isManager(s) || e.userId === s.userId || e.payload.createdBy === s.userId;
  const open = new Set<import("node:http").ServerResponse>();
  // Close live streams on shutdown, or the server waits for them forever.
  app.addHook("preClose", async () => {
    for (const r of open) r.end();
    open.clear();
  });

  app.get<{ Querystring: { lastEventId?: string } }>("/v1/merchant/events", { preHandler: staff }, async (req, reply) => {
    const s = me(req);
    const header = req.headers["last-event-id"];
    const fromHeader = typeof header === "string" ? Number(header) : NaN;
    const fromQuery = Number(req.query.lastEventId);
    let cursor = Number.isFinite(fromHeader) ? fromHeader : Number.isFinite(fromQuery) ? fromQuery : await latestMerchantEventId(db, s.merchantId);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": config.PUBLIC_WEB_URL,
    });
    res.write(`retry: 3000\n\n`);
    open.add(res);

    let busy = false;
    let again = false;
    const flush = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          for (const e of await merchantEventsSince(db, s.merchantId, cursor)) {
            cursor = e.id;
            if (!visible(s, e)) continue;
            const { createdBy: _createdBy, ...data } = e.payload;
            res.write(`id: ${e.id}\nevent: ${e.name}\ndata: ${JSON.stringify({ billId: e.billId, at: e.createdAt, ...data })}\n\n`);
          }
        } while (again);
      } finally {
        busy = false;
      }
    };
    await flush();
    const unsubscribe = d.subscribe(s.merchantId, () => void flush());
    const heartbeat = setInterval(() => res.write(`: hb\n\n`), 25_000);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
    });
  });
}
