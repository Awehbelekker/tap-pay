import { Crypto } from "@tappay/db";
import { ensureTestDatabase, freshTestDb } from "@tappay/db/testing";
import { loadConfig } from "@tappay/config";
import { apiEnv, E2E } from "./env.js";

// Playwright webServer: wipe, migrate and seed the e2e database, then start the real API.
Object.assign(process.env, apiEnv);
await ensureTestDatabase(E2E.databaseUrl);
const h = await freshTestDb(E2E.databaseUrl, Crypto.fromConfig(loadConfig(process.env)));
await h.close();
await import("../../api/src/main.js");
