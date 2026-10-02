import type { Kysely } from "kysely";
import type { Crypto } from "./crypto.js";
import type { Database } from "./db.js";

/**
 * Demo data for local development (MILESTONES M0): one merchant, a manager and a coach, three
 * tags and three services. Fixed ids so re-running is a no-op. Numbers are fictitious
 * (0600000001/2 are in an unallocated test range); never seed real customer data.
 */

export const SEED = {
  merchantId: "00000000-0000-4000-8000-000000000001",
  managerId: "00000000-0000-4000-8000-000000000011",
  coachId: "00000000-0000-4000-8000-000000000012",
  tags: {
    coach: "DEMO-COACH-1",
    till: "DEMO-TILL-1",
    spare: "DEMO-SPARE-1",
  },
} as const;

export async function seed(db: Kysely<Database>, crypto: Crypto): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("merchants")
      .values({
        id: SEED.merchantId,
        name: "Demo Surf School",
        trading_name: "Demo Surf School, Muizenberg",
        vat_number: null,
        mode: "appointment",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    const staff = [
      { id: SEED.managerId, display_name: "Demo Manager", role: "manager" as const, msisdn: "0600000001" },
      { id: SEED.coachId, display_name: "Sipho", role: "staff" as const, msisdn: "0600000002" },
    ];
    for (const s of staff) {
      await trx
        .insertInto("users")
        .values({
          id: s.id,
          merchant_id: SEED.merchantId,
          display_name: s.display_name,
          role: s.role,
          msisdn_enc: crypto.encrypt(s.msisdn),
          msisdn_hash: crypto.lookupHash(s.msisdn),
          pin_hash: null,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    }

    const tags = [
      { code: SEED.tags.coach, label: "Sipho wristband", assigned_user_id: SEED.coachId, status: "active" as const },
      { code: SEED.tags.till, label: "Front desk", assigned_user_id: null, status: "active" as const },
      { code: SEED.tags.spare, label: null, assigned_user_id: null, status: "unassigned" as const },
    ];
    for (const t of tags) {
      await trx
        .insertInto("tags")
        .values({ merchant_id: SEED.merchantId, kind: "static", uid: null, ...t })
        .onConflict((oc) => oc.column("code").doNothing())
        .execute();
    }

    const services = [
      { id: "00000000-0000-4000-8000-000000000101", name: "Beginner lesson", price_cents: 50000 },
      { id: "00000000-0000-4000-8000-000000000102", name: "Private lesson", price_cents: 90000 },
      { id: "00000000-0000-4000-8000-000000000103", name: "Board hire", price_cents: 15000 },
    ];
    for (const s of services) {
      await trx
        .insertInto("services")
        .values({ merchant_id: SEED.merchantId, ...s })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    }
  });
}
