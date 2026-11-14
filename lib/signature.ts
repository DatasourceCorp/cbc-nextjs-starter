import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies `X-Partner-Signature`: the lowercase hex HMAC-SHA256 of the RAW request
 * body (the exact bytes, before any JSON parsing), keyed with the UTF-8 bytes of the
 * whole webhook secret, `whsec_` prefix included. Compared in constant time.
 */
export function verifySignature(
  rawBody: Uint8Array,
  header: string | null | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(computeSignature(rawBody, secret), "utf8");
  const given = Buffer.from(header, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The signature the API would send for this body. Used by tests and the fake API. */
export function computeSignature(rawBody: Uint8Array | string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(rawBody).digest("hex");
}
