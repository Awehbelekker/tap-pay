import { loadConfig } from "@tappay/config";
import { createDb } from "@tappay/db";
import { createQueue } from "@tappay/db/queue";
import { buildApp } from "./app.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const queue = createQueue(config.DATABASE_URL);
await queue.start();

const app = buildApp({ config, db, queue });

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
