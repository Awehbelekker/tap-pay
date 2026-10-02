import { afterAll, describe, expect, it } from "vitest";
import { createQueue, QUEUES, SCHEDULE_TZ, SCHEDULES } from "../src/queue.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("job queue (integration)", () => {
  const q = createQueue(url!);
  afterAll(async () => q.stop().catch(() => undefined));

  it("is not ready before start, ready after, and start is repeatable", async () => {
    expect(await q.ready()).toBe(false);
    await q.start();
    expect(await q.ready()).toBe(true);
    for (const name of QUEUES) expect(await q.boss.getQueue(name)).toBeTruthy();
  });

  it("registers every schedule in Africa/Johannesburg", async () => {
    for (const s of SCHEDULES) await q.boss.schedule(s.name, s.cron, null, { tz: SCHEDULE_TZ });
    const got = await q.boss.getSchedules();
    expect(got.map((s) => s.name).sort()).toEqual(SCHEDULES.map((s) => s.name).sort());
    for (const s of got) expect(s.timezone).toBe(SCHEDULE_TZ);
  });

  it("round-trips a job", async () => {
    const id = await q.boss.send("webhook.replay", { eventId: "e1" });
    expect(id).toBeTruthy();
    const [job] = await q.boss.fetch<{ eventId: string }>("webhook.replay");
    expect(job?.data.eventId).toBe("e1");
  });
});
