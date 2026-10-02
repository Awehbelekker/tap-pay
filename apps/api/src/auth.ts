import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { jwtVerify, SignJWT } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Clock, WhatsAppClient } from "@tappay/core";
import type { Config } from "@tappay/config";
import { audit, type Crypto, type Database, type Kysely } from "@tappay/db";

/**
 * Staff auth (ARCHITECTURE "Auth"; SPEC 15). First sign-in on a device: a one-time code sent by
 * WhatsApp, then the staff member sets a PIN. After that the device signs in with the PIN.
 * Access tokens are short JWTs (15 minutes); refresh tokens rotate, and re-using a rotated one
 * revokes its whole family (stolen-token detection).
 *
 * Nothing here reveals whether a number is registered: OTP requests always succeed.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_15_MIN = 3;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;
/**
 * A phone on a weak signal can send a refresh, lose the response and retry with the same token.
 * Within this window that is a retry, not theft: issue a fresh token in the same family.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 30;

export type Role = "owner" | "manager" | "staff";

export interface Staff {
  userId: string;
  merchantId: string;
  role: Role;
  deviceId: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  expiresIn: number;
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "invalid_code"
      | "code_expired"
      | "pin_required"
      | "weak_pin"
      | "invalid_login"
      | "pin_locked"
      | "unknown_device"
      | "invalid_refresh"
      | "choose_merchant",
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = "AuthError";
  }
}

// ── PIN hashing (scrypt, no native dependency) ───────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(pin, Buffer.from(salt, "base64url"), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** 4 to 6 digits, and not trivially guessable (all one digit, or a straight run). */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return "PIN must be 4 to 6 digits";
  if (/^(\d)\1+$/.test(pin)) return "PIN cannot be one repeated digit";
  const d = [...pin].map(Number);
  const step = d[1]! - d[0]!;
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1]! === step)) return "PIN cannot be a straight run like 1234";
  return null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export interface AuthDeps {
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  wa: WhatsAppClient;
  clock: Clock;
}

export class Auth {
  private readonly key: Uint8Array;

  constructor(private readonly d: AuthDeps) {
    this.key = new TextEncoder().encode(d.config.JWT_SECRET);
  }

  private now(): Date {
    return this.d.clock.now();
  }

  private otpHash(userId: string, code: string): Buffer {
    return createHmac("sha256", this.d.config.HASH_PEPPER).update(`otp:${userId}:${code}`).digest();
  }

  private async activeUsersFor(msisdn: string) {
    return this.d.db
      .selectFrom("users")
      .innerJoin("merchants", "merchants.id", "users.merchant_id")
      .select(["users.id", "users.merchant_id", "users.role", "users.pin_hash", "users.pin_failures", "users.pin_locked_until", "merchants.name as merchantName"])
      .where("users.msisdn_hash", "=", this.d.crypto.lookupHash(msisdn))
      .where("users.active", "=", true)
      .where("merchants.status", "=", "active")
      .execute();
  }

  /** Send a sign-in code by WhatsApp. Always resolves, whether or not the number is staff. */
  async requestOtp(msisdn: string): Promise<void> {
    const { db, wa, config } = this.d;
    const users = await this.activeUsersFor(msisdn);
    if (users.length === 0) return;
    const since = new Date(this.now().getTime() - 15 * 60_000);
    const recent = await db
      .selectFrom("otp_codes")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("user_id", "=", users[0]!.id)
      .where("created_at", ">", since)
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= OTP_MAX_PER_15_MIN) return; // rate limited, silently
    const code = String(randomInt(1_000_000)).padStart(6, "0");
    const expiresAt = new Date(this.now().getTime() + OTP_TTL_MINUTES * 60_000);
    // One code for the number; a row per staff record so any of their merchants can be chosen.
    await db
      .insertInto("otp_codes")
      .values(users.map((u) => ({ user_id: u.id, code_hash: this.otpHash(u.id, code), expires_at: expiresAt, used_at: null })))
      .execute();
    await wa.sendTemplate(msisdn.replace(/\D/g, "").replace(/^0/, "27"), "otp", "en", [code, config.PRODUCT_NAME]);
  }

  /**
   * Check a code. First sign-in also sets the PIN. With several merchants on one number, the
   * caller must pass merchantId (a valid code without it returns the choices).
   */
  async verifyOtp(i: { msisdn: string; code: string; pin?: string | undefined; merchantId?: string | undefined; deviceLabel?: string | undefined }): Promise<Tokens> {
    const { db } = this.d;
    const now = this.now();
    const users = await this.activeUsersFor(i.msisdn);
    if (users.length === 0 || !/^\d{6}$/.test(i.code)) throw new AuthError("invalid_code", 401);

    const matches: { user: (typeof users)[number]; otpId: string }[] = [];
    for (const u of users) {
      const otp = await db
        .selectFrom("otp_codes")
        .select(["id", "code_hash", "attempts", "expires_at"])
        .where("user_id", "=", u.id)
        .where("used_at", "is", null)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!otp || otp.expires_at <= now || otp.attempts >= OTP_MAX_ATTEMPTS) continue;
      const ok = timingSafeEqual(otp.code_hash, this.otpHash(u.id, i.code));
      if (ok) matches.push({ user: u, otpId: otp.id });
      else await db.updateTable("otp_codes").set({ attempts: otp.attempts + 1 }).where("id", "=", otp.id).execute();
    }
    if (matches.length === 0) throw new AuthError("invalid_code", 401);

    const chosen = i.merchantId ? matches.find((m) => m.user.merchant_id === i.merchantId) : matches.length === 1 ? matches[0] : undefined;
    if (!chosen) {
      throw new AuthError("choose_merchant", 409, { merchants: matches.map((m) => ({ id: m.user.merchant_id, name: m.user.merchantName })) });
    }
    const u = chosen.user;

    if (!u.pin_hash) {
      if (!i.pin) throw new AuthError("pin_required", 400);
      const problem = pinProblem(i.pin);
      if (problem) throw new AuthError("weak_pin", 400, { message: problem });
    }
    await db.updateTable("otp_codes").set({ used_at: now }).where("id", "=", chosen.otpId).execute();
    if (!u.pin_hash && i.pin) {
      await db.updateTable("users").set({ pin_hash: await hashPin(i.pin), pin_failures: 0, pin_locked_until: null }).where("id", "=", u.id).execute();
    }
    const device = await db
      .insertInto("devices")
      .values({ user_id: u.id, merchant_id: u.merchant_id, label: (i.deviceLabel ?? "Phone").slice(0, 60), push_subscription: null, last_seen_at: now, revoked_at: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    await audit(db, { merchantId: u.merchant_id, actorKind: "user", actorId: u.id, action: "auth.device_enrolled", entity: "device", entityId: device.id });
    return this.issue({ userId: u.id, merchantId: u.merchant_id, role: u.role, deviceId: device.id }, randomUUID());
  }

  /** PIN sign-in on a device that was enrolled with a WhatsApp code. */
  async login(i: { msisdn: string; pin: string; deviceId: string }): Promise<Tokens> {
    const { db } = this.d;
    const now = this.now();
    const device = /^[0-9a-f-]{36}$/.test(i.deviceId)
      ? await db.selectFrom("devices").select(["id", "user_id", "revoked_at"]).where("id", "=", i.deviceId).executeTakeFirst()
      : undefined;
    const users = await this.activeUsersFor(i.msisdn);
    const u = device ? users.find((x) => x.id === device.user_id) : undefined;
    if (!device || device.revoked_at || !u) throw new AuthError("unknown_device", 401);
    if (u.pin_locked_until && u.pin_locked_until > now) throw new AuthError("pin_locked", 423, { until: u.pin_locked_until });
    if (!u.pin_hash || !(await verifyPin(i.pin, u.pin_hash))) {
      const failures = (u.pin_locked_until && u.pin_locked_until <= now ? 0 : u.pin_failures) + 1;
      const locked = failures >= PIN_MAX_FAILURES ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000) : null;
      await db.updateTable("users").set({ pin_failures: locked ? 0 : failures, pin_locked_until: locked }).where("id", "=", u.id).execute();
      if (locked) {
        await audit(db, { merchantId: u.merchant_id, actorKind: "user", actorId: u.id, action: "auth.pin_locked", entity: "user", entityId: u.id });
        throw new AuthError("pin_locked", 423, { until: locked });
      }
      throw new AuthError("invalid_login", 401);
    }
    await db.updateTable("users").set({ pin_failures: 0, pin_locked_until: null }).where("id", "=", u.id).execute();
    await db.updateTable("devices").set({ last_seen_at: now }).where("id", "=", device.id).execute();
    return this.issue({ userId: u.id, merchantId: u.merchant_id, role: u.role, deviceId: device.id }, randomUUID());
  }

  /** Rotate a refresh token. Re-using an already rotated token revokes the family. */
  async refresh(token: string): Promise<Tokens> {
    const { db } = this.d;
    const now = this.now();
    const row = await db
      .selectFrom("refresh_tokens")
      .innerJoin("users", "users.id", "refresh_tokens.user_id")
      .innerJoin("devices", "devices.id", "refresh_tokens.device_id")
      .select([
        "refresh_tokens.id",
        "refresh_tokens.family_id",
        "refresh_tokens.rotated_at",
        "refresh_tokens.revoked_at",
        "refresh_tokens.expires_at",
        "refresh_tokens.device_id",
        "users.id as userId",
        "users.merchant_id as merchantId",
        "users.role",
        "users.active",
        "devices.revoked_at as deviceRevokedAt",
      ])
      .where("refresh_tokens.token_hash", "=", sha256(token))
      .executeTakeFirst();
    if (!row || row.revoked_at || row.expires_at <= now || !row.active || row.deviceRevokedAt) throw new AuthError("invalid_refresh", 401);
    if (row.rotated_at && now.getTime() - row.rotated_at.getTime() <= REFRESH_REUSE_GRACE_SECONDS * 1000) {
      return this.issue({ userId: row.userId, merchantId: row.merchantId, role: row.role, deviceId: row.device_id }, row.family_id);
    }
    if (row.rotated_at) {
      await db.updateTable("refresh_tokens").set({ revoked_at: now }).where("family_id", "=", row.family_id).where("revoked_at", "is", null).execute();
      await audit(db, { merchantId: row.merchantId, actorKind: "system", actorId: null, action: "auth.refresh_reuse", entity: "device", entityId: row.device_id });
      throw new AuthError("invalid_refresh", 401);
    }
    const moved = await db.updateTable("refresh_tokens").set({ rotated_at: now }).where("id", "=", row.id).where("rotated_at", "is", null).executeTakeFirst();
    if (moved.numUpdatedRows !== 1n) throw new AuthError("invalid_refresh", 401);
    return this.issue({ userId: row.userId, merchantId: row.merchantId, role: row.role, deviceId: row.device_id }, row.family_id);
  }

  async logout(token: string): Promise<void> {
    const row = await this.d.db.selectFrom("refresh_tokens").select("family_id").where("token_hash", "=", sha256(token)).executeTakeFirst();
    if (row) await this.d.db.updateTable("refresh_tokens").set({ revoked_at: this.now() }).where("family_id", "=", row.family_id).execute();
  }

  private async issue(s: Staff, familyId: string): Promise<Tokens> {
    const now = this.now();
    const accessToken = await new SignJWT({ mid: s.merchantId, role: s.role, did: s.deviceId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(s.userId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + ACCESS_TTL_SECONDS)
      .sign(this.key);
    const refreshToken = randomBytes(32).toString("base64url");
    await this.d.db
      .insertInto("refresh_tokens")
      .values({
        user_id: s.userId,
        device_id: s.deviceId,
        family_id: familyId,
        token_hash: sha256(refreshToken),
        expires_at: new Date(now.getTime() + REFRESH_TTL_DAYS * 86_400_000),
        rotated_at: null,
        revoked_at: null,
      })
      .execute();
    return { accessToken, refreshToken, deviceId: s.deviceId, expiresIn: ACCESS_TTL_SECONDS };
  }

  /**
   * Check an access token and that the user and device are still allowed (a deactivated staff
   * member or revoked phone loses access at once, not after the token expires).
   */
  async verifyAccess(token: string): Promise<Staff | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], currentDate: this.now() });
      if (typeof payload.sub !== "string" || typeof payload.mid !== "string" || typeof payload.did !== "string") return null;
      const row = await this.d.db
        .selectFrom("users")
        .innerJoin("devices", "devices.user_id", "users.id")
        .select(["users.role", "users.active", "devices.revoked_at"])
        .where("users.id", "=", payload.sub)
        .where("users.merchant_id", "=", payload.mid)
        .where("devices.id", "=", payload.did)
        .executeTakeFirst();
      if (!row || !row.active || row.revoked_at) return null;
      return { userId: payload.sub, merchantId: payload.mid, role: row.role, deviceId: payload.did };
    } catch {
      return null;
    }
  }
}

declare module "fastify" {
  interface FastifyRequest {
    staff?: Staff;
  }
}

/** preHandler: bearer token (or ?access_token= for EventSource, which cannot set headers). */
export function requireStaff(auth: Auth, roles: Role[] = ["owner", "manager", "staff"]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const q = (req.query as Record<string, unknown> | undefined)?.access_token;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : typeof q === "string" ? q : null;
    const staff = token ? await auth.verifyAccess(token) : null;
    if (!staff) return reply.code(401).send({ code: "unauthorized", message: "sign in again" });
    if (!roles.includes(staff.role)) return reply.code(403).send({ code: "forbidden", message: "not allowed for your role" });
    req.staff = staff;
  };
}
