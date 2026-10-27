import {
  verifyHexHmacSignature,
  type HexHmacSignatureFailure,
  type HexHmacSignatureResult,
} from './hex-hmac-signature.ts'

/**
 * Lemon Squeezy webhook signature verification: an HMAC-SHA256 hex digest of the
 * raw body, sent as `X-Signature`. The scheme lives in `hex-hmac-signature.ts`,
 * which Creem shares; this name stays because it is exported.
 */

export type LemonSqueezySignatureFailure = HexHmacSignatureFailure
export type LemonSqueezySignatureResult = HexHmacSignatureResult

export function verifyLemonSqueezySignature(input: {
  readonly rawBody: string
  readonly header: string | undefined
  readonly secret: string
}): LemonSqueezySignatureResult {
  return verifyHexHmacSignature(input)
}
