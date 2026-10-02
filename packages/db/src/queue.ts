import { PgBoss } from "pg-boss";

/**
 * Job queue on Postgres (pg-boss). Queue names and schedules mirror ARCHITECTURE "Jobs"; the
 * handlers are added by the milestone that owns each job. Schedules run in Africa/Johannesburg.
 */

export const QUEUES = [
  "reminder.send",
  "session.expire",
  "bill.expire",
  "payout.run",
  "reconcile.payments",
  "notify.retry",
  "webhook.replay",
  "retention.sweep",
  "summary.daily",
] as const;
export type QueueName = (typeof QUEUES)[number];

export const SCHEDULES: { name: QueueName; cron: string }[] = [
  { name: "session.expire", cron: "* * * * *" },
  { name: "reminder.send", cron: "* * * * *" },
  { name: "bill.expire", cron: "*/15 * * * *" },
  { name: "payout.run", cron: "0 6 * * *" },
  { name: "reconcile.payments", cron: "*/15 * * * *" },
  { name: "notify.retry", cron: "* * * * *" },
  { name: "retention.sweep", cron: "30 2 * * *" },
  { name: "summary.daily", cron: "30 6 * * *" },
];

export const SCHEDULE_TZ = "Africa/Johannesburg";

export interface Queue {
  boss: PgBoss;
  start(): Promise<void>;
  stop(): Promise<void>;
  ready(): Promise<boolean>;
}

export function createQueue(databaseUrl: string, onError: (e: Error) => void = () => undefined): Queue {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  let started = false;
  boss.on("error", onError);
  return {
    boss,
    async start() {
      await boss.start();
      for (const q of QUEUES) await boss.createQueue(q);
      started = true;
    },
    async stop() {
      started = false;
      await boss.stop({ graceful: true });
    },
    async ready() {
      return started && (await boss.isInstalled());
    },
  };
}
