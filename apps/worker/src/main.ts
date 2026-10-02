import { pino } from "pino";
import { loadConfig } from "@tappay/config";
import { createQueue, SCHEDULE_TZ, SCHEDULES } from "@tappay/db/queue";

/**
 * Background worker (ARCHITECTURE: apps/worker). M0 installs the queues and schedules; each
 * job's handler is registered by the milestone that owns it (session.expire in M1/M2,
 * reminder.send in M7, ...). payout.run is handled in the API process (OPEN_QUESTIONS I29).
 * Unhandled scheduled jobs simply wait.
 */
const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const queue = createQueue(config.DATABASE_URL, (e) => log.error({ err: e.message }, "queue error"));

await queue.start();
for (const s of SCHEDULES) {
  await queue.boss.schedule(s.name, s.cron, null, { tz: SCHEDULE_TZ });
}
log.info({ schedules: SCHEDULES.length }, "worker started");

const shutdown = async (signal: string) => {
  log.info({ signal }, "worker stopping");
  await queue.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
