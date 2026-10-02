import { createHmac, randomBytes, randomInt } from "node:crypto";

/**
 * Claim tokens (SPEC 19): 6 characters, base32 without look-alikes, single use, short TTL,
 * stored only as an HMAC so a database leak does not reveal live tokens.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1

export const CLAIM_TOKEN_LENGTH = 6;

export function newClaimToken(): string {
  let s = "";
  for (let i = 0; i < CLAIM_TOKEN_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function hashToken(token: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(`claim:${token.toUpperCase()}`).digest();
}

/** Parse the prefilled WhatsApp text "PAY <token>". Case-insensitive, tolerant of spacing. */
export function parsePayCommand(text: string): string | null {
  const m = /^\s*pay\s+([a-z0-9]{6})\s*$/i.exec(text);
  if (!m) return null;
  const t = m[1]!.toUpperCase();
  for (const ch of t) if (!ALPHABET.includes(ch)) return null;
  return t;
}

/** Unguessable URL token for receipts and bill links (192 bits). */
export function newUrlToken(): string {
  return randomBytes(24).toString("base64url");
}
