import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "@tappay/config";
import { dbReady, type DbHandle } from "@tappay/db";
import { loggerOptions } from "./logger.js";

export interface QueueProbe {
  ready(): Promise<boolean>;
}

export interface AppDeps {
  config: Config;
  db: DbHandle;
  queue: QueueProbe;
}

/** Build the HTTP app. Kept free of listen() so tests drive it with app.inject(). */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(deps.config.LOG_LEVEL),
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  // Only the merchant PWA origin may call the API from a browser.
  void app.register(cors, { origin: [deps.config.PUBLIC_WEB_URL], credentials: true });

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

  return app;
}
