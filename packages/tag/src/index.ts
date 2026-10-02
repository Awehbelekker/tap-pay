/**
 * Tag URLs and verification (SPEC 18). M0: URL building and the verifier interface.
 * NTAG424 DNA SDM verification (AES-CMAC, key diversification per NXP AN12196, with the
 * application note's test vectors) is implemented in M9; static tags are used until then and
 * are refused in production unless ALLOW_STATIC_TAGS=true.
 */

export type TagVerification =
  | { ok: true; tagCode: string; counter: number | null }
  | { ok: false; reason: "unknown_tag" | "revoked" | "bad_signature" | "replayed" | "static_not_allowed" };

export interface TagVerifier {
  verify(input: { tagCode: string; query: Record<string, string | undefined> }): Promise<TagVerification>;
}

const TAG_CODE = /^[A-Z0-9-]{4,32}$/;

export function isValidTagCode(code: string): boolean {
  return TAG_CODE.test(code);
}

/** URL written to the tag. Points at our domain, never directly at WhatsApp (spec backend step 1). */
export function tagUrl(tapDomain: string, tagCode: string): string {
  if (!isValidTagCode(tagCode)) throw new Error("invalid tag code");
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(tapDomain) ? "http" : "https";
  return `${scheme}://${tapDomain}/t/${tagCode}`;
}

/** wa.me deep link with the prefilled claim message (SPEC 18). */
export function waMeLink(waPhoneNumber: string, claimToken: string): string {
  return `https://wa.me/${waPhoneNumber}?text=${encodeURIComponent(`PAY ${claimToken}`)}`;
}
