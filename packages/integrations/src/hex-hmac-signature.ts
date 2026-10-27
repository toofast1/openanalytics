import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-SHA256 hex-digest verification over a raw body.
 *
 * The scheme Lemon Squeezy (`X-Signature`) and Creem (`creem-signature`) both
 * use: no timestamp, no version prefix, one hex digest of the body under the
 * endpoint's secret. Named for the scheme, beside `standard-webhooks-signature`,
 * so the next provider that signs this way finds it instead of a third copy.
 *
 * No timestamp is signed, so there is no replay window to enforce; the ledger's
 * dedupe is what makes a replayed delivery harmless.
 */

export type HexHmacSignatureFailure = 'malformed_header' | 'no_matching_signature'

export type HexHmacSignatureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: HexHmacSignatureFailure }

/** A SHA-256 hex digest, and nothing else. */
const HEX_DIGEST = /^[0-9a-f]{64}$/iu

/**
 * Never throws. The header is checked for shape before it is decoded, because
 * `Buffer.from(x, 'hex')` silently drops what is not hex: a 64-character header
 * with one stray character decodes short, and `timingSafeEqual` throws on a
 * length mismatch — a 500 on a delivery the provider would then retry.
 */
export function verifyHexHmacSignature(input: {
  readonly rawBody: string
  readonly header: string | undefined
  readonly secret: string
}): HexHmacSignatureResult {
  const header = input.header?.trim() ?? ''
  if (!HEX_DIGEST.test(header)) return { ok: false, reason: 'malformed_header' }

  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest()
  return timingSafeEqual(Buffer.from(header, 'hex'), expected)
    ? { ok: true }
    : { ok: false, reason: 'no_matching_signature' }
}
