import { loadConfig } from "@tappay/config";
import { Crypto } from "../crypto.js";
import { createDb } from "../db.js";
import { seed } from "../seed.js";

const config = loadConfig();
if (config.NODE_ENV === "production") {
  console.error("refusing to seed demo data in production");
  process.exit(1);
}
const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
try {
  await seed(db, Crypto.fromConfig(config));
  console.log("seeded demo merchant, 2 staff, 3 tags, 3 services");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
