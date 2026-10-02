import type { FastifyInstance } from "fastify";
import { formatRands, cents, WebhookSignatureError, type PaymentProvider } from "@tappay/core";
import type { Config } from "@tappay/config";
import { finishWebhookEvent, receiptView, recordWebhookEvent, type Crypto, type DbHandle } from "@tappay/db";
import { MockPaymentProvider, type MockOutcome } from "@tappay/providers";
import { methodLabel, renderSlipPng, type SlipData } from "@tappay/slip";
import { parseInbound, SimWhatsAppClient, verifyMetaSignature } from "@tappay/whatsapp";
import type { PayFlow } from "./flow.js";

export interface RouteDeps {
  config: Config;
  db: DbHandle;
  crypto: Crypto;
  flow: PayFlow;
  provider: PaymentProvider;
  wa: unknown;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#111827}button{font:inherit;padding:12px 16px;border-radius:10px;border:0;margin:6px 0;width:100%;cursor:pointer}.ok{background:#0f766e;color:#fff}.alt{background:#e5e7eb}img{max-width:100%}</style></head><body>${body}</body></html>`;
}

const NOT_VERIFIED = page("Payment unavailable", "<h1>Payment unavailable</h1><p>We could not verify this tag. Please ask staff to take payment another way.</p>");

type ReceiptView = NonNullable<Awaited<ReturnType<typeof receiptView>>>;

/**
 * What the customer's slip shows (MESSAGES.md "Slip fields"). The tip is its own line, named
 * for the staff member when there is one; a share's slip shows the share, not the whole table's
 * bill; a quick tip has no bill lines. The split between parties is never shown.
 */
export function slipData(v: ReceiptView, product: string): SlipData {
  return {
    product,
    merchant: v.merchantName,
    receiptNumber: v.number,
    reference: v.paymentId.slice(0, 8),
    paidAt: v.paidAt,
    lines: v.shareLabel
      ? [{ description: v.shareLabel, amount: cents(v.base ?? 0) }]
      : (v.lines ?? []).map((l) => ({ description: l.description, amount: cents(l.amountCents * (l.quantity ?? 1)) })),
    base: cents(v.base ?? 0),
    tip: cents(v.tip),
    total: cents(v.total),
    method: methodLabel(v.method),
    staff: v.tip > 0 ? v.staffName : null,
  };
}

export function registerRoutes(app: FastifyInstance, d: RouteDeps): void {
  const { config, flow, provider } = d;

  // ── Tag tap (SPEC 18) ──────────────────────────────────────────────────────
  app.get<{ Params: { code: string } }>("/t/:code", async (req, reply) => {
    const location = await flow.tapRedirect(req.params.code);
    // Failures never say why (SPEC 18): one generic page for unknown, revoked or unverified tags.
    if (!location) return reply.code(404).type("text/html").send(NOT_VERIFIED);
    return reply.header("cache-control", "no-store").redirect(location, 302);
  });

  // ── Bill link or QR (field, remote invoice, any bill) ──────────────────────
  app.get<{ Params: { token: string } }>("/b/:token", async (req, reply) => {
    const location = await flow.billLinkRedirect(req.params.token);
    if (!location) return reply.code(404).type("text/html").send(page("Bill", "<h1>Bill not available</h1><p>This bill is paid, cancelled or expired. Please ask the merchant.</p>"));
    return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(location, 302);
  });

  // ── Webhooks: raw body so signatures are checked over exact bytes ──────────
  void app.register(async (r) => {
    r.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    // Meta verification handshake.
    r.get<{ Querystring: Record<string, string | undefined> }>("/webhooks/whatsapp", async (req, reply) => {
      const q = req.query;
      if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WA_VERIFY_TOKEN && q["hub.challenge"]) {
        return reply.type("text/plain").send(q["hub.challenge"]);
      }
      return reply.code(403).send({ code: "forbidden", message: "verification failed" });
    });

    r.post("/webhooks/whatsapp", async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifyMetaSignature(config.WA_APP_SECRET, raw, req.headers["x-hub-signature-256"] as string | undefined)) {
        req.log.warn("whatsapp webhook rejected: bad signature");
        return reply.code(401).send({ code: "bad_signature", message: "signature check failed" });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ code: "bad_json", message: "body is not JSON" });
      }
      for (const m of parseInbound(body)) {
        // Dedupe by WhatsApp message id. Only non-PII fields are kept in webhook_events.
        const eventId = await recordWebhookEvent(d.db.db, { source: "whatsapp", externalId: m.messageId, signatureOk: true, payload: { kind: m.kind } });
        if (!eventId) continue;
        try {
          await flow.handleInbound(m);
          await finishWebhookEvent(d.db.db, eventId, "processed");
        } catch (e) {
          req.log.error({ err: (e as Error).message }, "inbound message failed");
          await finishWebhookEvent(d.db.db, eventId, "failed", (e as Error).name);
        }
      }
      // Always 200 once the signature is good, so Meta does not retry what we already stored.
      return reply.send({ ok: true });
    });

    r.post<{ Params: { provider: string } }>("/webhooks/provider/:provider", async (req, reply) => {
      if (req.params.provider !== provider.name) return reply.code(404).send({ code: "unknown_provider", message: "not configured" });
      const raw = req.body as Buffer;
      let ev;
      try {
        ev = await provider.verifyWebhook({ headers: req.headers as Record<string, string | undefined>, rawBody: Buffer.isBuffer(raw) ? raw : Buffer.alloc(0) });
      } catch (e) {
        req.log.warn({ provider: provider.name, reason: (e as Error).message }, "provider webhook rejected");
        const code = e instanceof WebhookSignatureError ? 401 : 400;
        return reply.code(code).send({ code: "bad_signature", message: "signature check failed" });
      }
      const eventId = await recordWebhookEvent(d.db.db, {
        source: provider.name,
        externalId: ev.eventId,
        signatureOk: true,
        payload: { type: ev.type, providerRef: ev.providerRef, reference: ev.reference, amount: ev.amount },
      });
      if (!eventId) return reply.send({ ok: true, duplicate: true });
      try {
        const r2 = await flow.handleProviderEvent(ev);
        await finishWebhookEvent(d.db.db, eventId, r2.status, r2.error);
      } catch (e) {
        req.log.error({ err: (e as Error).message }, "provider event failed");
        await finishWebhookEvent(d.db.db, eventId, "failed", (e as Error).name);
        // 500 so the provider retries; the event row lets webhook.replay recover it too.
        return reply.code(500).send({ code: "processing_failed", message: "try again" });
      }
      return reply.send({ ok: true });
    });
  });

  // ── Mock hosted checkout (dev and tests only) ──────────────────────────────
  if (provider instanceof MockPaymentProvider) {
    const mock = provider;
    app.get<{ Params: { ref: string } }>("/mock-checkout/:ref", async (req, reply) => {
      const p = await d.db.db.selectFrom("payments").select(["amount_cents", "status"]).where("provider", "=", "mock").where("provider_ref", "=", req.params.ref).executeTakeFirst();
      if (!p) return reply.code(404).type("text/html").send(page("Checkout", "<h1>Checkout not found</h1>"));
      const ref = esc(req.params.ref);
      return reply.type("text/html").send(
        page(
          "Mock checkout",
          `<h1>Mock checkout</h1><p>Amount <strong>${esc(formatRands(cents(p.amount_cents)))}</strong></p>
<p>This page stands in for the provider's hosted checkout with Apple Pay and Google Pay.</p>
<button class="ok" data-o="succeeded">Approve with Apple Pay</button>
<button class="alt" data-o="failed">Decline</button>
<button class="alt" data-o="cancelled">Cancel</button>
<button class="alt" data-o="succeeded" data-r="2">Approve, send webhook twice</button>
<p id="out"></p>
<script>
document.querySelectorAll("button").forEach(b => b.onclick = async () => {
  const r = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: b.dataset.o, repeat: Number(b.dataset.r || 1) }) });
  document.getElementById("out").textContent = r.ok ? "Done. Return to WhatsApp." : "Something went wrong.";
});
</script>`.replaceAll("location.pathname", JSON.stringify(`/mock-checkout/${ref}`)),
        ),
      );
    });

    app.post<{ Params: { ref: string }; Body: { outcome?: string; repeat?: number } }>("/mock-checkout/:ref", async (req, reply) => {
      const outcome = req.body?.outcome;
      if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") return reply.code(400).send({ code: "bad_outcome", message: "outcome?" });
      let hook;
      try {
        hook = mock.resolve(req.params.ref, outcome as MockOutcome);
      } catch {
        return reply.code(404).send({ code: "not_found", message: "unknown checkout" });
      }
      const repeat = Math.min(Math.max(Number(req.body?.repeat ?? 1), 1), 5);
      const statuses: number[] = [];
      for (let i = 0; i < repeat; i++) {
        const res = await app.inject({ method: "POST", url: "/webhooks/provider/mock", headers: hook.headers, payload: hook.rawBody });
        statuses.push(res.statusCode);
      }
      return reply.send({ ok: true, webhookStatuses: statuses });
    });
  }

  app.get("/pay/return", async (_req, reply) =>
    reply.type("text/html").send(page("Payment", "<h1>Thank you</h1><p>Return to WhatsApp. Your slip arrives there once the payment is confirmed.</p>")),
  );

  // ── Receipts (unguessable token) ───────────────────────────────────────────
  const receiptToken = /^[A-Za-z0-9_-]{32}$/;
  app.get<{ Params: { token: string } }>("/r/:token", async (req, reply) => {
    const t = req.params.token;
    const v = receiptToken.test(t) ? await receiptView(d.db.db, t) : undefined;
    if (!v) return reply.code(404).type("text/html").send(page("Receipt", "<h1>Receipt not found</h1>"));
    return reply
      .header("cache-control", "private, no-store")
      .header("referrer-policy", "no-referrer")
      .type("text/html")
      .send(page(`Receipt ${v.number}`, `<img alt="Receipt ${esc(v.number)} from ${esc(v.merchantName)}" src="/r/${t}/slip.png">`));
  });

  app.get<{ Params: { token: string } }>("/r/:token/slip.png", async (req, reply) => {
    const t = req.params.token;
    const v = receiptToken.test(t) ? await receiptView(d.db.db, t) : undefined;
    if (!v) return reply.code(404).send({ code: "not_found", message: "receipt not found" });
    const png = await renderSlipPng(slipData(v, config.PRODUCT_NAME));
    return reply.header("cache-control", "private, max-age=3600").type("image/png").send(png);
  });

  // ── Simulator outbox (WA_MODE=sim only; config forbids sim in production) ──
  if (d.wa instanceof SimWhatsAppClient) {
    const sim = d.wa;
    app.get<{ Querystring: { to?: string; after?: string } }>("/sim/outbox", async (req, reply) => {
      const to = req.query.to ?? "";
      const after = Number(req.query.after ?? 0);
      const items = sim.outbox.map((m, i) => ({ seq: i + 1, ...m })).filter((m) => m.to === to && m.seq > after);
      return reply.send({ items });
    });
  }
}
