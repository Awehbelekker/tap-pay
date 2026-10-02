import { randomUUID } from "node:crypto";
import { loadConfig } from "@tappay/config";
import { createDb } from "../db.js";
import { createBill } from "../repos.js";
import { SEED } from "../seed.js";

/**
 * Dev helper until the merchant PWA can create bills (M4): put an open "Beginner lesson R500"
 * bill on the demo coach's tag. Usage: pnpm demo:bill [amountInRand]
 */
const config = loadConfig();
if (config.NODE_ENV === "production") {
  console.error("refusing to create demo bills in production");
  process.exit(1);
}
const rand = Number(process.argv[2] ?? 500);
const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
try {
  const tag = await db.selectFrom("tags").select(["id", "assigned_user_id"]).where("code", "=", SEED.tags.coach).executeTakeFirstOrThrow();
  await db.updateTable("bills").set({ status: "cancelled" }).where("tag_id", "=", tag.id).where("status", "in", ["open", "claimed"]).execute();
  const bill = await createBill(db, {
    merchantId: SEED.merchantId,
    tagId: tag.id,
    assignedUserId: tag.assigned_user_id,
    createdBy: SEED.coachId,
    lines: [{ description: "Beginner lesson", amountCents: Math.round(rand * 100) }],
    billToken: randomUUID(),
    expiresAt: new Date(Date.now() + config.BILL_EXPIRY_HOURS * 3_600_000),
  });
  console.log(`open bill ${bill.id} for R${rand} on tag ${SEED.tags.coach}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
