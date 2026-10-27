import { createHmac } from 'node:crypto'
import {
  createLogger,
  createServiceMetadata,
  type LogLevel,
  type Logger,
  type ServiceMetadata,
} from '@openanalytics/observability'

/**
 * Test helpers shared by the unit, contract, integration and migration projects.
 */

export interface CapturedLogger {
  readonly logger: Logger
  /** Parsed log lines, in emission order. */
  readonly lines: Record<string, unknown>[]
  /** Every line whose `msg` matches. */
  find(message: string): Record<string, unknown>[]
  clear(): void
}

/**
 * Logger that captures structured lines instead of writing to stdout.
 *
 * Assertions about redaction need the parsed object, not a formatted string —
 * a test that greps text would pass on `"[redacted]"` appearing anywhere.
 */
export function createCapturedLogger(
  options: { level?: LogLevel; service?: ServiceMetadata } = {},
): CapturedLogger {
  const lines: Record<string, unknown>[] = []
  const service =
    options.service ??
    createServiceMetadata({ name: 'test', version: '0.0.0-test', environment: 'test' })

  const logger = createLogger({
    service,
    level: options.level ?? 'debug',
    sink: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>)
    },
    // Fixed clock so log assertions do not depend on wall time.
    now: () => new Date('2026-07-21T00:00:00.000Z'),
  })

  return {
    logger,
    lines,
    find: (message) => lines.filter((line) => line['msg'] === message),
    clear: () => {
      lines.length = 0
    },
  }
}

/**
 * Minimal env source for `loadServiceEnv`.
 *
 * Tests pass an explicit record rather than mutating `process.env`, so parallel
 * test files cannot interfere with each other.
 */
export function testEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'debug',
    SERVICE_VERSION: '0.0.0-test',
    GIT_COMMIT: 'testcommit',
    PORT: '3000',
    ...overrides,
  }
}

/**
 * Builds a valid `Stripe-Signature` header for a raw body, so webhook tests can
 * exercise the real verifier with a test secret. Mirrors Stripe's scheme:
 * HMAC-SHA256 of `${timestamp}.${payload}` under the endpoint secret.
 */
export function signStripeWebhook(input: {
  payload: string
  secret: string
  timestamp?: number
}): string {
  const t = input.timestamp ?? Math.floor(new Date('2026-07-22T00:00:00.000Z').getTime() / 1000)
  const signature = createHmac('sha256', input.secret).update(`${t}.${input.payload}`).digest('hex')
  return `t=${t},v1=${signature}`
}

/**
 * Builds the three Standard Webhooks headers for a raw body, so the Polar
 * webhook tests exercise the real verifier with a test secret.
 *
 * `secretEncoding` mirrors the verifier's parameter and defaults to `'raw'` —
 * **Polar's** derivation, which HMACs under the secret's literal UTF-8 bytes
 * with the `whsec_` prefix included rather than the base64-decoded key the
 * Standard Webhooks specification defines. That deviation was verified against
 * real sandbox deliveries on 2026-08-27; a signer that quietly used the spec's
 * derivation would make the Polar suite prove something about our imagination
 * rather than about Polar.
 */
export function signStandardWebhook(input: {
  payload: string
  secret: string
  webhookId?: string
  timestamp?: number
  secretEncoding?: 'base64' | 'raw'
}): Record<string, string> {
  const id = input.webhookId ?? 'whid_test_1'
  const t = input.timestamp ?? Math.floor(new Date('2026-07-22T00:00:00.000Z').getTime() / 1000)
  const key =
    (input.secretEncoding ?? 'raw') === 'raw'
      ? Buffer.from(input.secret, 'utf8')
      : Buffer.from(input.secret.replace(/^whsec_/u, ''), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${t}.${input.payload}`).digest('base64')
  return {
    'webhook-id': id,
    'webhook-timestamp': String(t),
    'webhook-signature': `v1,${signature}`,
  }
}

/**
 * Builds the Lemon Squeezy HMAC-SHA256 signature header for a raw request body.
 */
export function signLemonSqueezyWebhook(input: {
  payload: string
  secret: string
}): Record<string, string> {
  const signature = createHmac('sha256', input.secret).update(input.payload).digest('hex')
  return {
    'x-signature': signature,
  }
}
