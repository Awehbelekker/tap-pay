/**
 * API client for the merchant PWA. The access token lives in memory only; the refresh token,
 * device id and number are kept in localStorage so the next visit is a PIN sign-in. A 401
 * triggers one refresh, then a fresh sign-in.
 */

export const API = (import.meta.env.VITE_PUBLIC_API_URL as string | undefined) ?? "http://localhost:3000";

const K = { refresh: "tp.refresh", device: "tp.device", msisdn: "tp.msisdn" } as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: stay signed in for this tab only */
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  expiresIn: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let access: string | null = null;
let onSignedOut: () => void = () => undefined;

export const session = {
  get deviceId() {
    return read(K.device);
  },
  get msisdn() {
    return read(K.msisdn);
  },
  get access() {
    return access;
  },
  hasRefresh: () => Boolean(read(K.refresh)),
  onSignedOut(fn: () => void) {
    onSignedOut = fn;
  },
  store(t: Tokens, msisdn: string) {
    access = t.accessToken;
    write(K.refresh, t.refreshToken);
    write(K.device, t.deviceId);
    write(K.msisdn, msisdn);
  },
  /** Forget tokens but keep device and number, so the next sign-in is just the PIN. */
  signOut() {
    const rt = read(K.refresh);
    if (rt) void fetch(`${API}/v1/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt }) }).catch(() => undefined);
    access = null;
    write(K.refresh, null);
    onSignedOut();
  },
  forgetDevice() {
    access = null;
    write(K.refresh, null);
    write(K.device, null);
    write(K.msisdn, null);
    onSignedOut();
  },
};

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (access) headers.set("authorization", `Bearer ${access}`);
  return fetch(`${API}${path}`, { ...init, headers });
}

let refreshing: Promise<boolean> | null = null;
export async function refresh(): Promise<boolean> {
  const rt = read(K.refresh);
  if (!rt) return false;
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${API}/v1/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt }) });
      if (!r.ok) return false;
      const t = (await r.json()) as Tokens;
      session.store(t, read(K.msisdn) ?? "");
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let r = await raw(path, init);
  if (r.status === 401 && (await refresh())) r = await raw(path, init);
  if (r.status === 401) {
    session.signOut();
    throw new ApiError(401, "unauthorized", "Please sign in again");
  }
  const body = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, body?.code ?? "error", body?.message ?? "Something went wrong", body?.details);
  return body as T;
}

/** A file from the API (CSV export), with the same sign-in handling as `api`. */
export async function apiBlob(path: string): Promise<Blob> {
  let r = await raw(path);
  if (r.status === 401 && (await refresh())) r = await raw(path);
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new ApiError(r.status, body?.code ?? "error", body?.message ?? "Something went wrong");
  }
  return r.blob();
}

/** Unauthenticated auth calls. */
export async function authCall<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, json?.code ?? "error", json?.message ?? "Something went wrong", json?.details);
  return json as T;
}

// ── Types the screens use (mirror api/openapi.yaml) ─────────────────────────

export interface Me {
  user: { id: string; name: string; role: "owner" | "manager" | "staff"; muted: boolean };
  merchant: { id: string; name: string; mode: string; tipsEnabled: boolean };
  myTags: { code: string; label: string | null }[];
  vapidPublicKey: string | null;
}

export interface Bill {
  id: string;
  type: "fixed" | "open" | "quick_tip";
  status: string;
  lines: { description: string; amountCents: number }[];
  subtotalCents: number;
  tipCents: number;
  billCode: string | null;
  link: string;
  tagCode: string | null;
  tableLabel: string | null;
  staffName: string | null;
  hasShares: boolean;
  maskedCustomer: string | null;
  customerName: string | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
}

export interface Service {
  id: string;
  name: string;
  priceCents: number;
}

export interface Tag {
  code: string;
  label: string | null;
  status: string;
  kind: string;
  assignedUserId: string | null;
  assignedName: string | null;
  url: string;
}

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  active: boolean;
  maskedNumber: string;
}

export interface Today {
  date: string;
  count: number;
  totalCents: number;
  tipCents: number;
}

/** "R1 234,50" (MESSAGES.md conventions). */
export function rands(c: number): string {
  const whole = Math.floor(Math.abs(c) / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${c < 0 ? "-" : ""}R${whole},${String(Math.abs(c) % 100).padStart(2, "0")}`;
}

/** "85", "85,50", "1 234.50" to cents; null if not a clean amount. */
export function parseRands(s: string): number | null {
  const t = s.trim().replace(/^r\s*/i, "").replace(/\s+/g, "").replace(",", ".");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Cached service list so New bill opens on a weak signal (SPEC 15). */
export const serviceCache = {
  get(): Service[] {
    try {
      return JSON.parse(localStorage.getItem("tp.services") ?? "[]") as Service[];
    } catch {
      return [];
    }
  },
  set(items: Service[]) {
    write("tp.services", JSON.stringify(items));
  },
};

export interface Balance {
  partyKind: "merchant" | "staff" | "pool";
  userId: string | null;
  name: string | null;
  earnedCents: number;
  tipCents: number;
  refundedCents: number;
  feeCents: number;
  paidOutCents: number;
  adjustmentCents: number;
  balanceCents: number;
}

export interface Payout {
  id: string;
  userId: string | null;
  name: string | null;
  amountCents: number;
  status: "pending" | "sent" | "failed";
  method: string;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface Payment {
  id: string;
  billId: string | null;
  description: string;
  amountCents: number;
  baseCents: number;
  tipCents: number;
  refundedCents: number;
  providerFeeCents: number;
  status: "succeeded" | "partially_refunded" | "refunded";
  paidAt: string;
  maskedCustomer: string | null;
  receiptUrl: string | null;
}

export interface MoneySettings {
  tipRule: "direct" | "pool" | "house_cut";
  tipHouseCutBp: number;
  feePolicy: "proportional" | "merchant_absorbs";
  payoutThresholdCents: number;
}

export interface SplitRule {
  serviceId: string | null;
  staffUserId: string | null;
  basisPoints: number;
}

export interface ReportSummary {
  from: string;
  to: string;
  count: number;
  grossCents: number;
  baseCents: number;
  tipCents: number;
  feeCents: number;
  refundCount: number;
  refundCents: number;
  netCents: number;
  reconciled: boolean;
  byDay: { date: string; count: number; grossCents: number; tipCents: number }[];
  byParty: { partyKind: string; userId: string | null; name: string | null; salesCents: number; tipCents: number; feeCents: number; refundCents: number; netCents: number }[];
  byService: { serviceId: string | null; name: string; count: number; amountCents: number }[];
}

export interface Business {
  name: string;
  tradingName: string | null;
  vatRegistered: boolean;
  vatNumber: string | null;
  address: string | null;
}

export interface UnpaidBill {
  id: string;
  status: "abandoned" | "needs_follow_up";
  description: string;
  amountCents: number;
  abandonedAt: string;
  staffName: string | null;
  customer: { name: string | null; maskedNumber: string | null; number: string | null };
  remindersSent: number;
  reminderLimit: number;
  nextReminderAt: string | null;
  optedOut: boolean;
  link: string;
}

export interface ReminderSettings {
  reminderCount: number;
  reminderFirstDelayMinutes: number;
  reminderWindowStart: number;
  reminderWindowEnd: number;
}
