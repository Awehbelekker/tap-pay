import { sql } from "kysely";
import type pg from "pg";
import type { Db } from "./repos.js";

/**
 * Merchant live events (ARCHITECTURE "Realtime"). Each event is a row (so a reconnecting PWA
 * resumes with Last-Event-ID) and a Postgres NOTIFY (so every API instance can push it to its
 * open SSE streams without polling).
 */

export const EVENTS_CHANNEL = "merchant_events";

export interface MerchantEventInput {
  merchantId: string;
  name: string;
  billId: string | null;
  /** Staff member the event is about (assigned to the bill). Staff only see their own. */
  userId: string | null;
  payload: Record<string, unknown>;
}

export interface MerchantEventRow {
  id: number;
  merchantId: string;
  name: string;
  billId: string | null;
  userId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Append and announce. NOTIFY is delivered on commit when called inside a transaction. */
export async function appendMerchantEvent(db: Db, e: MerchantEventInput): Promise<number> {
  const r = await db
    .insertInto("merchant_events")
    .values({ merchant_id: e.merchantId, name: e.name, bill_id: e.billId, user_id: e.userId, payload: JSON.stringify(e.payload) })
    .returning("id")
    .executeTakeFirstOrThrow();
  await sql`select pg_notify(${EVENTS_CHANNEL}, ${`${e.merchantId}:${r.id}`})`.execute(db);
  return r.id;
}

export async function merchantEventsSince(db: Db, merchantId: string, afterId: number, limit = 200): Promise<MerchantEventRow[]> {
  const rows = await db
    .selectFrom("merchant_events")
    .select(["id", "merchant_id", "name", "bill_id", "user_id", "payload", "created_at"])
    .where("merchant_id", "=", merchantId)
    .where("id", ">", afterId)
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({ id: r.id, merchantId: r.merchant_id, name: r.name, billId: r.bill_id, userId: r.user_id, payload: r.payload, createdAt: r.created_at }));
}

export async function latestMerchantEventId(db: Db, merchantId: string): Promise<number> {
  const r = await db.selectFrom("merchant_events").select((eb) => eb.fn.max("id").as("id")).where("merchant_id", "=", merchantId).executeTakeFirst();
  return Number(r?.id ?? 0);
}

/**
 * Hold one connection that LISTENs for events and calls `onEvent(merchantId, id)`. Reconnects
 * after a dropped connection. Returns a stop function.
 */
export async function listenMerchantEvents(
  pool: pg.Pool,
  onEvent: (merchantId: string, id: number) => void,
  onError: (e: Error) => void = () => undefined,
): Promise<() => Promise<void>> {
  let client: pg.PoolClient | null = null;
  let stopped = false;

  const connect = async (): Promise<void> => {
    try {
      client = await pool.connect();
      client.on("notification", (m) => {
        const [merchantId, id] = (m.payload ?? "").split(":");
        if (merchantId && id) onEvent(merchantId, Number(id));
      });
      client.on("error", (e) => {
        onError(e);
        client?.release(true);
        client = null;
        if (!stopped) setTimeout(() => void connect(), 1000);
      });
      await client.query(`listen ${EVENTS_CHANNEL}`);
    } catch (e) {
      onError(e as Error);
      if (!stopped) setTimeout(() => void connect(), 1000);
    }
  };
  await connect();

  return async () => {
    stopped = true;
    if (client) {
      await client.query(`unlisten ${EVENTS_CHANNEL}`).catch(() => undefined);
      client.release();
      client = null;
    }
  };
}
