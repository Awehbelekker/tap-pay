import { loadConfig } from "@tappay/config";
import { createDb } from "../db.js";
import { migrateDown, migrateUp } from "../migrate.js";

// Usage: migrate up | migrate down [steps]
const [cmd = "up", stepsArg] = process.argv.slice(2);
const config = loadConfig();
const { pool, close } = createDb(config.DATABASE_URL, { max: 1 });

try {
  if (cmd === "up") {
    const done = await migrateUp(pool);
    console.log(done.length ? `applied: ${done.join(", ")}` : "up to date");
  } else if (cmd === "down") {
    const done = await migrateDown(pool, Number(stepsArg ?? 1));
    console.log(done.length ? `reverted: ${done.join(", ")}` : "nothing to revert");
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
