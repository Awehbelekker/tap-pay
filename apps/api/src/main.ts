import { loadConfig } from "@tappay/config";
import { createDb } from "@tappay/db";
import { createQueue } from "@tappay/db/queue";
import { buildApp } from "./app.js";
import type { Money } from "./money.js";
import type { Reports } from "./reports.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const queue = createQueue(config.DATABASE_URL);
await queue.start();

const app = buildApp({ config, db, queue });

// Jobs that need the API's services run here; apps/worker owns the schedules (06:00 SAST).
await queue.boss.work("payout.run", async () => {
  const r = await (app as unknown as { money: Money }).money.runAllPayouts();
  app.log.info(r, "payout run");
});
await queue.boss.work("summary.daily", async () => {
  const r = await (app as unknown as { reports: Reports }).reports.sendDailySummaries();
  app.log.info(r, "daily summaries");
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await queue.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });
