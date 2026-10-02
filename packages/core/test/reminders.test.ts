import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideReminder, DEFAULT_REMINDER_POLICY, firstReminderDue, inWindow, nextAllowed, sastDay, validPolicy, type ReminderPolicy } from "../src/reminders.js";

const sast = (s: string) => new Date(`${s}+02:00`);

/**
 * Simulate the reminder job: it wakes at arbitrary moments (gaps from a minute to hours, as a
 * job can be late), sends what decideReminder allows and plans the next. Returns send times.
 */
function simulate(abandonedAt: Date, policy: ReminderPolicy, gapsMinutes: number[], extraDueNow: number[] = []): Date[] {
  const sent: Date[] = [];
  if (policy.count === 0) return sent;
  let row: { seq: number; dueAt: Date } | null = { seq: 1, dueAt: firstReminderDue(abandonedAt, policy) };
  let now = abandonedAt;
  for (const [i, g] of gapsMinutes.entries()) {
    now = new Date(now.getTime() + g * 60_000);
    // A manager pressing "Send reminder" just makes the next one due now.
    if (row && extraDueNow.includes(i)) row = { ...row, dueAt: now };
    if (!row || row.dueAt > now) continue;
    const d = decideReminder({ seq: row.seq, now, abandonedAt, lastSentAt: sent.at(-1) ?? null, sentCount: sent.length, policy });
    if (d.action === "stop") row = null;
    else if (d.action === "defer") row = { ...row, dueAt: d.dueAt };
    else {
      sent.push(now);
      row = d.next;
    }
  }
  return sent;
}

const arbPolicy: fc.Arbitrary<ReminderPolicy> = fc
  .record({ count: fc.integer({ min: 0, max: 3 }), firstDelayMinutes: fc.integer({ min: 1, max: 1440 }), windowStartHour: fc.integer({ min: 8, max: 19 }), span: fc.integer({ min: 1, max: 12 }) })
  .map(({ span, ...p }) => ({ ...p, windowEndHour: Math.min(20, p.windowStartHour + span) }));
const arbInstant = fc.integer({ min: Date.parse("2026-01-01T00:00:00Z"), max: Date.parse("2027-12-31T00:00:00Z") }).map((n) => new Date(n));

describe("reminder schedule (SPEC 11)", () => {
  it("default: 10 minutes later, next day 09:00, third day 09:00", () => {
    const sent = simulate(sast("2026-10-05T10:00:00"), DEFAULT_REMINDER_POLICY, Array(6 * 24 * 60).fill(1));
    expect(sent.map((d) => d.toISOString())).toEqual(["2026-10-05T08:10:00.000Z", "2026-10-06T07:00:00.000Z", "2026-10-08T07:00:00.000Z"]);
  });

  it("abandoned at night: the first waits for 08:00, and the second for the day after", () => {
    const sent = simulate(sast("2026-10-05T22:30:00"), DEFAULT_REMINDER_POLICY, Array(6 * 24 * 60).fill(1));
    expect(sent.map((d) => d.toISOString())).toEqual(["2026-10-06T06:00:00.000Z", "2026-10-07T06:00:00.000Z", "2026-10-08T07:00:00.000Z"]);
  });

  it("window edges: 08:00 and 19:59 are in, 20:00 and 07:59 are out", () => {
    expect(inWindow(sast("2026-10-05T08:00:00"))).toBe(true);
    expect(inWindow(sast("2026-10-05T19:59:00"))).toBe(true);
    expect(inWindow(sast("2026-10-05T20:00:00"))).toBe(false);
    expect(inWindow(sast("2026-10-05T07:59:00"))).toBe(false);
    expect(nextAllowed(sast("2026-10-05T20:00:00"), null).toISOString()).toBe("2026-10-06T06:00:00.000Z");
  });

  it("policy validation keeps the window inside 08:00 to 20:00", () => {
    expect(validPolicy({ count: 3, firstDelayMinutes: 10, windowStartHour: 7, windowEndHour: 20 })).toBe(false);
    expect(validPolicy({ count: 4, firstDelayMinutes: 10, windowStartHour: 8, windowEndHour: 20 })).toBe(false);
    expect(validPolicy({ count: 2, firstDelayMinutes: 60, windowStartHour: 9, windowEndHour: 17 })).toBe(true);
  });

  it("property: never more than the cap (<= 3), never two on one SAST day, never outside the window", () => {
    fc.assert(
      fc.property(arbInstant, arbPolicy, fc.array(fc.integer({ min: 1, max: 240 }), { minLength: 1, maxLength: 400 }), fc.array(fc.nat(399), { maxLength: 10 }), (abandonedAt, policy, gaps, manual) => {
        const sent = simulate(abandonedAt, policy, gaps, manual);
        expect(sent.length).toBeLessThanOrEqual(Math.min(policy.count, 3));
        const days = sent.map(sastDay);
        expect(new Set(days).size).toBe(days.length);
        for (const s of sent) {
          expect(inWindow(s, policy)).toBe(true);
          expect(inWindow(s)).toBe(true); // and inside 08:00 to 20:00
          expect(s.getTime()).toBeGreaterThan(abandonedAt.getTime());
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("property: a job that wakes every minute sends all of them within four days", () => {
    fc.assert(
      fc.property(arbInstant, arbPolicy, (abandonedAt, policy) => {
        const sent = simulate(abandonedAt, policy, Array(5 * 24 * 60).fill(1));
        expect(sent.length).toBe(policy.count);
      }),
      { numRuns: 100 },
    );
  });
});
