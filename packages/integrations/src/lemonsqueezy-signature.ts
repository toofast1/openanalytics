import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Lemon Squeezy webhook signature verification.
 *
 * Lemon Squeezy signs incoming webhooks with an HMAC-SHA256 hex digest
 * of the raw payload body using the endpoint's signing secret, and
 * transmits it in the `X-Signature` request header.
 */

export type LemonSqueezySignatureFailure = 'malformed_header' | 'no_matching_signature'

export type LemonSqueezySignatureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: LemonSqueezySignatureFailure }

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/**
 * Verifies a Lemon Squeezy webhook signature against the raw request body.
 */
export function verifyLemonSqueezySignature(input: {
  readonly rawBody: string
  readonly header: string | undefined
  readonly secret: string
}): LemonSqueezySignatureResult {
  if (!input.header || typeof input.header !== 'string' || input.header.trim() === '') {
    return { ok: false, reason: 'malformed_header' }
  }

  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest('hex')
  const incoming = input.header.trim()

  return safeEqualHex(incoming, expected)
    ? { ok: true }
    : { ok: false, reason: 'no_matching_signature' }
}
