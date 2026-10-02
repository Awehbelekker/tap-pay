/**
 * Reminder timing for unpaid bills (SPEC 11). Pure functions over instants; South Africa has
 * no daylight saving, so SAST is always UTC+2.
 *
 * Rules (property-tested): at most `count` (<= 3) reminders per bill, at most one per SAST
 * day, and only inside the merchant's window, which is never wider than 08:00 to 20:00 SAST.
 * A reminder that falls due outside the window waits for the next allowed moment.
 *
 * Nominal schedule: #1 `firstDelayMinutes` after abandonment, #2 the next day at 09:00, #3 three
 * days after abandonment at 09:00 (the last). The job sends what is due and plans the next.
 */

export interface ReminderPolicy {
  /** 0 to 3 reminders per bill. */
  count: number;
  firstDelayMinutes: number;
  /** Hours of the SAST day, start inclusive, end exclusive; within 8..20. */
  windowStartHour: number;
  windowEndHour: number;
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = { count: 3, firstDelayMinutes: 10, windowStartHour: 8, windowEndHour: 20 };
export const MAX_REMINDERS = 3;
export const EARLIEST_HOUR = 8;
export const LATEST_HOUR = 20;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SAST = 2 * HOUR;

export function validPolicy(p: ReminderPolicy): boolean {
  return (
    Number.isInteger(p.count) &&
    p.count >= 0 &&
    p.count <= MAX_REMINDERS &&
    Number.isInteger(p.firstDelayMinutes) &&
    p.firstDelayMinutes >= 1 &&
    p.firstDelayMinutes <= 1440 &&
    Number.isInteger(p.windowStartHour) &&
    Number.isInteger(p.windowEndHour) &&
    p.windowStartHour >= EARLIEST_HOUR &&
    p.windowEndHour <= LATEST_HOUR &&
    p.windowStartHour < p.windowEndHour
  );
}

/** Never trust stored settings to be inside the legal window. */
function clamp(p: ReminderPolicy): ReminderPolicy {
  const start = Math.min(Math.max(p.windowStartHour, EARLIEST_HOUR), LATEST_HOUR - 1);
  const end = Math.max(Math.min(p.windowEndHour, LATEST_HOUR), start + 1);
  return { ...p, count: Math.min(Math.max(p.count, 0), MAX_REMINDERS), windowStartHour: start, windowEndHour: end };
}

/** SAST day number (days since the epoch in SAST). */
export function sastDay(t: Date): number {
  return Math.floor((t.getTime() + SAST) / DAY);
}

/** The instant of `hour`:00 SAST on SAST day `day`. */
function at(day: number, hour: number): Date {
  return new Date(day * DAY + hour * HOUR - SAST);
}

function minuteOfDay(t: Date): number {
  return Math.floor(((t.getTime() + SAST) % DAY) / 60_000);
}

export function inWindow(t: Date, policy: ReminderPolicy = DEFAULT_REMINDER_POLICY): boolean {
  const p = clamp(policy);
  const m = minuteOfDay(t);
  return m >= p.windowStartHour * 60 && m < p.windowEndHour * 60;
}

/** When reminder `seq` (1-based) is meant to go, before window and once-a-day rules. */
export function nominalDue(seq: number, abandonedAt: Date, policy: ReminderPolicy = DEFAULT_REMINDER_POLICY): Date {
  const day = sastDay(abandonedAt);
  if (seq === 1) return new Date(abandonedAt.getTime() + policy.firstDelayMinutes * 60_000);
  if (seq === 2) return at(day + 1, 9);
  return at(day + 3, 9);
}

/** The earliest moment at or after `t` when a reminder may go, given the last one sent. */
export function nextAllowed(t: Date, lastSentAt: Date | null, policy: ReminderPolicy = DEFAULT_REMINDER_POLICY): Date {
  const p = clamp(policy);
  let x = t;
  if (lastSentAt && sastDay(x) <= sastDay(lastSentAt)) x = at(sastDay(lastSentAt) + 1, p.windowStartHour);
  const m = minuteOfDay(x);
  if (m < p.windowStartHour * 60) return at(sastDay(x), p.windowStartHour);
  if (m >= p.windowEndHour * 60) return at(sastDay(x) + 1, p.windowStartHour);
  return x;
}

export type ReminderDecision = { action: "send"; isLast: boolean; next: { seq: number; dueAt: Date } | null } | { action: "defer"; dueAt: Date } | { action: "stop" };

/**
 * What the reminder job does with reminder `seq` that is due at `now`: send it (and plan the
 * next one), wait for the next allowed moment, or stop because the cap is reached.
 */
export function decideReminder(i: { seq: number; now: Date; abandonedAt: Date; lastSentAt: Date | null; sentCount: number; policy: ReminderPolicy }): ReminderDecision {
  const p = clamp(i.policy);
  if (i.sentCount >= p.count || i.seq > p.count) return { action: "stop" };
  const allowed = nextAllowed(i.now, i.lastSentAt, p);
  if (allowed.getTime() !== i.now.getTime()) return { action: "defer", dueAt: allowed };
  const isLast = i.sentCount + 1 >= p.count;
  if (isLast) return { action: "send", isLast, next: null };
  const seq = i.seq + 1;
  const dueAt = nextAllowed(new Date(Math.max(nominalDue(seq, i.abandonedAt, p).getTime(), i.now.getTime())), i.now, p);
  return { action: "send", isLast, next: { seq, dueAt } };
}

/** When the first reminder should be due after abandonment (already inside the window). */
export function firstReminderDue(abandonedAt: Date, policy: ReminderPolicy = DEFAULT_REMINDER_POLICY): Date {
  return nextAllowed(nominalDue(1, abandonedAt, policy), null, policy);
}
