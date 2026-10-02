import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * PII protection (ARCHITECTURE: tenancy and data protection).
 *   encrypt: AES-256-GCM, layout = [keyId(1)][iv(12)][tag(16)][ciphertext]; the key id byte allows
 *            rotation (decrypt looks the key up by id).
 *   lookupHash: HMAC-SHA256(normalised msisdn, HASH_PEPPER) for equality lookups.
 */

const IV_LEN = 12;
const TAG_LEN = 16;

export class Crypto {
  private readonly keys: Map<number, Buffer>;

  constructor(
    keys: { id: number; keyBase64: string }[],
    private readonly currentKeyId: number,
    private readonly pepper: string,
  ) {
    this.keys = new Map();
    for (const k of keys) {
      const buf = Buffer.from(k.keyBase64, "base64");
      if (buf.length !== 32) throw new Error(`encryption key ${k.id} must be 32 bytes`);
      if (k.id < 0 || k.id > 255) throw new Error("key id must fit in one byte");
      this.keys.set(k.id, buf);
    }
    if (!this.keys.has(currentKeyId)) throw new Error("current key id has no key");
  }

  static fromConfig(c: { ENCRYPTION_KEY: string; HASH_PEPPER: string }): Crypto {
    return new Crypto([{ id: 1, keyBase64: c.ENCRYPTION_KEY }], 1, c.HASH_PEPPER);
  }

  encrypt(plain: string): Buffer {
    const key = this.keys.get(this.currentKeyId)!;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([this.currentKeyId]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Buffer): string {
    const keyId = blob[0];
    const key = keyId === undefined ? undefined : this.keys.get(keyId);
    if (!key) throw new Error("unknown encryption key id");
    const iv = blob.subarray(1, 1 + IV_LEN);
    const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const body = blob.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  lookupHash(msisdn: string): Buffer {
    return createHmac("sha256", this.pepper).update(normaliseMsisdn(msisdn)).digest();
  }
}

/** Digits only, South African local numbers (0XXXXXXXXX) converted to 27XXXXXXXXX. */
export function normaliseMsisdn(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (/^0\d{9}$/.test(digits)) return `27${digits.slice(1)}`;
  return digits;
}

/** "***482": what merchants see without consent (SPEC 13). */
export function maskMsisdn(msisdn: string): string {
  const d = normaliseMsisdn(msisdn);
  return `***${d.slice(-3)}`;
}
