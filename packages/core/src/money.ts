/**
 * Money is integer cents (ZAR). Never a float. `Cents` is a branded number that is always a
 * non-negative safe integer; signed ledger amounts use `SignedCents`.
 */

declare const centsBrand: unique symbol;
declare const signedBrand: unique symbol;
export type Cents = number & { readonly [centsBrand]: true };
export type SignedCents = number & { readonly [signedBrand]: true };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n) || n < 0) throw new MoneyError(`not a non-negative integer cent amount: ${n}`);
  return n as Cents;
}

export function signedCents(n: number): SignedCents {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`not an integer cent amount: ${n}`);
  return n as SignedCents;
}

export function addCents(...xs: Cents[]): Cents {
  return cents(xs.reduce<number>((a, b) => a + b, 0));
}

/**
 * Parse what a customer types ("25", "25.5", "R 1 234,50", "1,234.50") into cents.
 * Returns null for anything ambiguous or invalid; never rounds silently (max 2 decimals).
 */
export function parseRands(input: string): Cents | null {
  let s = input.trim().replace(/^r\s*/i, "").replace(/\s+/g, "");
  if (s === "") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the later one is the decimal separator, the other groups thousands.
    const dec = lastComma > lastDot ? "," : ".";
    const grp = dec === "," ? "." : ",";
    s = s.split(grp).join("").replace(dec, ".");
  } else if (lastComma >= 0) {
    // Only commas: a single comma followed by 1-2 digits is a decimal (SA style); else grouping.
    s = /^\d+,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.split(",").join("");
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  const total = whole * 100 + frac;
  return Number.isSafeInteger(total) ? cents(total) : null;
}

/**
 * Format for customer messages: "R1 234,50" (MESSAGES.md conventions; space thousands,
 * comma decimals). See OPEN_QUESTIONS O1: the PDF spec shows "R 500.00".
 */
export function formatRands(c: Cents | SignedCents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${neg ? "-" : ""}R${whole},${frac}`;
}

/** floor(amount * bp / 10000) — used for every non-merchant split share (SPEC 8.2). */
export function shareFloor(amount: Cents, basisPoints: number): Cents {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new MoneyError(`basis points out of range: ${basisPoints}`);
  }
  // BigInt keeps this exact for any safe-integer amount.
  return cents(Number((BigInt(amount) * BigInt(basisPoints)) / 10000n));
}

/** Percent tip: round half up to the cent on the bill amount (SPEC 7). */
export function percentTip(bill: Cents, basisPoints: number): Cents {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) throw new MoneyError(`bad tip basis points: ${basisPoints}`);
  return cents(Number((BigInt(bill) * BigInt(basisPoints) + 5000n) / 10000n));
}

/**
 * Parse a typed percentage ("12%", "12.5 %", "12,5%") into basis points. The % sign is
 * required so "15" stays a rand amount. Max 2 decimals; null for anything else.
 */
export function parsePercent(input: string): number | null {
  const m = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*%\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
