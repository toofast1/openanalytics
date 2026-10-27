import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Lemon Squeezy webhook signature verification.
 *
 * An HMAC-SHA256 hex digest of the raw body under the endpoint's signing
 * secret, sent as `X-Signature`. No timestamp is signed, so unlike Standard
 * Webhooks there is no replay window to enforce; the ledger's dedupe is what
 * makes a replayed delivery harmless.
 */

export type LemonSqueezySignatureFailure = 'malformed_header' | 'no_matching_signature'

export type LemonSqueezySignatureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: LemonSqueezySignatureFailure }

/** A SHA-256 hex digest, and nothing else. */
const HEX_DIGEST = /^[0-9a-f]{64}$/iu

/**
 * Never throws. The header is checked for shape before it is decoded, because
 * `Buffer.from(x, 'hex')` silently drops what is not hex: a 64-character header
 * with one stray character decodes short, and `timingSafeEqual` throws on a
 * length mismatch — a 500 on a delivery Lemon Squeezy would then retry.
 */
export function verifyLemonSqueezySignature(input: {
  readonly rawBody: string
  readonly header: string | undefined
  readonly secret: string
}): LemonSqueezySignatureResult {
  const header = input.header?.trim() ?? ''
  if (!HEX_DIGEST.test(header)) return { ok: false, reason: 'malformed_header' }

  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest()
  return timingSafeEqual(Buffer.from(header, 'hex'), expected)
    ? { ok: true }
    : { ok: false, reason: 'no_matching_signature' }
}
