import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { systemClock, type Clock, type PaymentProvider, type PushClient, type WhatsAppClient } from "@tappay/core";
import type { Config } from "@tappay/config";
import { Crypto, dbReady, listenMerchantEvents, type DbHandle } from "@tappay/db";
import { MockPaymentProvider } from "@tappay/providers";
import { SimWhatsAppClient } from "@tappay/whatsapp";
import { Auth } from "./auth.js";
import { PayFlow } from "./flow.js";
import { registerMerchantApi } from "./merchantApi.js";
import { Notifier } from "./notifier.js";
import { DisabledPushClient, WebPushClient } from "./push.js";
import { loggerOptions } from "./logger.js";
import { registerRoutes } from "./routes.js";

export interface QueueProbe {
  ready(): Promise<boolean>;
}

export interface AppDeps {
  config: Config;
  db: DbHandle;
  queue: QueueProbe;
  clock?: Clock;
  wa?: WhatsAppClient;
  provider?: PaymentProvider;
  push?: PushClient;
}

/** Adapters from config. Real WhatsApp and provider adapters are built in M8 from current docs. */
export function defaultAdapters(config: Config, clock: Clock): { wa: WhatsAppClient; provider: PaymentProvider } {
  if (config.WA_MODE !== "sim") throw new Error("WA_MODE=cloud: the Cloud API client is built in M8");
  if (config.PROVIDER !== "mock") throw new Error(`PROVIDER=${config.PROVIDER}: real provider adapters are built in M8`);
  return {
    wa: new SimWhatsAppClient(),
    provider: new MockPaymentProvider({ secret: config.MOCK_PROVIDER_SECRET, publicApiUrl: config.PUBLIC_API_URL, clock, checkoutTtlMinutes: config.SESSION_TTL_MINUTES }),
  };
}

/** Build the HTTP app. Kept free of listen() so tests drive it with app.inject(). */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(deps.config.LOG_LEVEL),
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  // Only the merchant PWA origin may call the API from a browser. Methods and headers are listed
  // explicitly: @fastify/cors defaults to GET, HEAD and POST only, which silently broke PUT/PATCH
  // from the PWA (found by the Playwright tests).
  void app.register(cors, {
    origin: [deps.config.PUBLIC_WEB_URL],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "last-event-id"],
    maxAge: 600,
  });

  // Liveness: the process is up. No dependencies.
  app.get("/healthz", async () => ({ ok: true }));

  // Readiness: database reachable with migrations applied, and the job queue started.
  app.get("/readyz", async (_req, reply) => {
    const [db, queue] = await Promise.all([dbReady(deps.db.db), deps.queue.ready().catch(() => false)]);
    const ok = db.ok && queue;
    const body = ok
      ? { ok: true, db: "ok", queue: "ok" }
      : { code: "not_ready", message: "service not ready", details: { db: db.ok ? "ok" : db.error, queue: queue ? "ok" : "unavailable" } };
    return reply.code(ok ? 200 : 503).send(body);
  });

  const clock = deps.clock ?? systemClock;
  const adapters = deps.wa && deps.provider ? { wa: deps.wa, provider: deps.provider } : defaultAdapters(deps.config, clock);
  const crypto_ = Crypto.fromConfig(deps.config);
  const { config } = deps;
  const push =
    deps.push ??
    (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
      ? new WebPushClient({ publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT })
      : new DisabledPushClient());
  const notifier = new Notifier({ db: deps.db.db, crypto: crypto_, wa: adapters.wa, push, log: app.log });
  const flow = new PayFlow({ config, db: deps.db.db, crypto: crypto_, wa: adapters.wa, provider: adapters.provider, clock, log: app.log, events: notifier });
  const auth = new Auth({ config, db: deps.db.db, crypto: crypto_, wa: adapters.wa, clock });

  // Live events: one LISTEN connection per API process, started on the first SSE subscriber.
  const listeners = new Map<string, Set<(id: number) => void>>();
  let stopListening: Promise<() => Promise<void>> | null = null;
  const subscribe = (merchantId: string, fn: (id: number) => void) => {
    stopListening ??= listenMerchantEvents(
      deps.db.pool,
      (mid, id) => listeners.get(mid)?.forEach((f) => f(id)),
      (e) => app.log.warn({ err: e.message }, "event listener"),
    );
    const set = listeners.get(merchantId) ?? new Set();
    set.add(fn);
    listeners.set(merchantId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) listeners.delete(merchantId);
    };
  };
  app.addHook("onClose", async () => {
    if (stopListening) await (await stopListening)();
  });
  registerMerchantApi(app, { config, db: deps.db.db, crypto: crypto_, auth, flow, clock, subscribe, vapidPublicKey: config.VAPID_PUBLIC_KEY ?? null });
  registerRoutes(app, { config: deps.config, db: deps.db, crypto: crypto_, flow, provider: adapters.provider, wa: adapters.wa });
  // The merchant API (M4) authenticates and then calls these flow methods; tests use them directly.
  app.decorate("payFlow", flow);
  app.decorate("auth", auth);

  return app;
}
