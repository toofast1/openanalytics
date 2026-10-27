import {
  LEMONSQUEEZY_API_BASE,
  LEMONSQUEEZY_LIST_PAGE_SIZE,
  LEMONSQUEEZY_REVENUE_PROVIDER_ID,
  createLemonSqueezyRevenueAdapter,
} from '@openanalytics/integrations'
import { signLemonSqueezyWebhook } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import {
  lemonSqueezyEvent,
  lemonSqueezyOrder,
  lemonSqueezySubscriptionInvoice,
} from '../support/revenue-fixtures.ts'

/**
 * The Lemon Squeezy revenue adapter's semantics.
 *
 * Modeled on the Polar and Dodo suites, proving the RevenueAdapter port contract
 * with Lemon Squeezy-specific semantics:
 *
 * 1. **The amount is `total - tax`** (or `subtotal`). Lemon Squeezy is a merchant of record,
 *    so `total` includes tax collected and remitted by Lemon Squeezy that the seller never receives.
 * 2. **Amounts are integer passthrough in minor units (cents).** Non-integers or fractional
 *    amounts are refused rather than rounded.
 * 3. **Never stores the customer email.**
 * 4. **Orders with status `paid` normalize to `succeeded`.** Orders marked `refunded` or with
 *    non-zero `refunded_amount` normalize to `refunded` or `partially_refunded`.
 * 5. **Webhook verification uses HMAC-SHA256 hex digest** over the raw request body with
 *    the secret, compared against the `x-signature` header.
 * 6. **Subscription lifecycle events without money** (`subscription_created`, etc.) normalize
 *    to `no_observations`.
 * 7. **Probe verifies credentials** against `GET /v1/orders?page[size]=1`.
 */

const adapter = createLemonSqueezyRevenueAdapter()
const HEADERS = { 'x-signature': 'sig_test_1' }

function normalizeOne(event: Record<string, unknown>, headers = HEADERS) {
  const outcome = adapter.normalizeEvent(event, { headers })
  if (!outcome.ok) throw new Error(`normalize failed: ${outcome.reason}`)
  return outcome.event
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/vnd.api+json' },
    ...init,
  })
}

describe('adapter metadata and constants', () => {
  it('exposes the lemonsqueezy provider id and base URL', () => {
    expect(LEMONSQUEEZY_REVENUE_PROVIDER_ID).toBe('lemonsqueezy')
    expect(adapter.providerId).toBe(LEMONSQUEEZY_REVENUE_PROVIDER_ID)
    expect(LEMONSQUEEZY_API_BASE).toBe('https://api.lemonsqueezy.com/v1')
    expect(LEMONSQUEEZY_LIST_PAGE_SIZE).toBe(100)
  })
})

describe('normalizeEvent — orders become charges', () => {
  it('reads order_created net of the tax Lemon Squeezy remits', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', lemonSqueezyOrder()))
    expect(event.eventType).toBe('order_created')
    expect(event.observations).toHaveLength(1)
    const [observation] = event.observations
    expect(observation?.objectId).toBe('ord_test_1')
    expect(observation?.objectKind).toBe('charge')
    expect(observation?.normalized).toMatchObject({
      object_kind: 'charge',
      status: 'succeeded',
      livemode: true,
      currency: 'usd',
      // 6049 total, 1050 tax -> 4999 seller gross revenue
      gross_minor: 4999,
      net_minor: 4999,
      fee_minor: 0,
      fee_currency: '',
      order_id: 'ord_test_1',
      checkout_session_id: '',
      client_reference_id: 'site_user_1',
      customer_id: '101',
      product_id: '201',
      product_name: 'Pro Subscription',
      parent_object_id: '',
    })
  })

  it('never stores the customer email it was sent', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', lemonSqueezyOrder()))
    expect(JSON.stringify(event.observations)).not.toContain('buyer@example.com')
  })

  it('reads a null tax as untaxed (0 tax)', () => {
    const order = lemonSqueezyOrder()
    const attrs = order['attributes'] as Record<string, unknown>
    attrs['tax'] = null
    attrs['subtotal'] = 6049
    const event = normalizeOne(lemonSqueezyEvent('order_created', order))
    expect(event.observations[0]?.normalized.gross_minor).toBe(6049)
  })

  it('refuses an order with missing total or tax', () => {
    const order = lemonSqueezyOrder()
    const attrs = order['attributes'] as Record<string, unknown>
    delete attrs['tax']
    const event = normalizeOne(lemonSqueezyEvent('order_created', order))
    expect(event.ignored).toBe('unsupported_object_shape')
  })

  it.each([
    ['a fractional total', { total: 6049.5 }],
    ['a tax larger than total', { tax: 7000 }],
    ['a negative tax', { tax: -1 }],
    ['no currency', { currency: null }],
  ])('refuses %s instead of rounding it into a plausible number', (_label, overrides) => {
    const order = lemonSqueezyOrder()
    const attrs = order['attributes'] as Record<string, unknown>
    Object.assign(attrs, overrides)
    const event = normalizeOne(lemonSqueezyEvent('order_created', order))
    expect(event.ignored).toBe('unsupported_object_shape')
  })

  it('reads a zero-total order as zero revenue', () => {
    const order = lemonSqueezyOrder()
    const attrs = order['attributes'] as Record<string, unknown>
    attrs['total'] = 0
    attrs['subtotal'] = 0
    attrs['tax'] = 0
    const event = normalizeOne(lemonSqueezyEvent('order_created', order))
    expect(event.observations[0]?.normalized.gross_minor).toBe(0)
    expect(event.observations[0]?.normalized.net_minor).toBe(0)
  })

  it('maps an order with refunded=true and full amount to refunded', () => {
    const order = lemonSqueezyOrder()
    const attrs = order['attributes'] as Record<string, unknown>
    attrs['refunded'] = true
    attrs['refunded_amount'] = 6049
    const event = normalizeOne(lemonSqueezyEvent('order_refunded', order))
    expect(event.observations[0]?.normalized.status).toBe('refunded')
  })

  it('maps an order with partial refunded_amount to partially_refunded', () => {
    const order = lemonSqueezyOrder()
    const attrs = order['attributes'] as Record<string, unknown>
    attrs['refunded'] = true
    attrs['refunded_amount'] = 1500
    const event = normalizeOne(lemonSqueezyEvent('order_refunded', order))
    expect(event.observations[0]?.normalized.status).toBe('partially_refunded')
  })

  it('maps pending, failed, and paid statuses correctly', () => {
    for (const [raw, expected] of [
      ['paid', 'succeeded'],
      ['pending', 'pending'],
      ['failed', 'failed'],
    ] as const) {
      const order = lemonSqueezyOrder()
      const attrs = order['attributes'] as Record<string, unknown>
      attrs['status'] = raw
      const event = normalizeOne(lemonSqueezyEvent('order_created', order))
      expect(event.observations[0]?.normalized.status).toBe(expected)
    }
  })

  it('reports livemode false for test_mode payloads', () => {
    const order = lemonSqueezyOrder()
    const attrs = order['attributes'] as Record<string, unknown>
    attrs['test_mode'] = true
    const event = normalizeOne(
      lemonSqueezyEvent('order_created', order, {
        meta: { event_name: 'order_created', test_mode: true },
      }),
    )
    expect(event.observations[0]?.normalized.livemode).toBe(false)
  })
})

describe('normalizeEvent — subscription payment invoices', () => {
  it('reads subscription_payment_success as a charge', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('subscription_payment_success', lemonSqueezySubscriptionInvoice()),
    )
    expect(event.eventType).toBe('subscription_payment_success')
    expect(event.observations).toHaveLength(1)
    const [observation] = event.observations
    expect(observation?.objectId).toBe('inv_test_1')
    expect(observation?.objectKind).toBe('charge')
    expect(observation?.normalized).toMatchObject({
      object_kind: 'charge',
      status: 'succeeded',
      gross_minor: 4999,
      net_minor: 4999,
      subscription_id: '501',
      customer_id: '101',
    })
  })

  it('reads subscription_payment_failed as a failed charge', () => {
    const invoice = lemonSqueezySubscriptionInvoice()
    const attrs = invoice['attributes'] as Record<string, unknown>
    attrs['status'] = 'uncollectible'
    const event = normalizeOne(lemonSqueezyEvent('subscription_payment_failed', invoice))
    expect(event.observations[0]?.normalized.status).toBe('failed')
  })

  it('reads subscription_payment_refunded as a refunded charge', () => {
    const invoice = lemonSqueezySubscriptionInvoice()
    const attrs = invoice['attributes'] as Record<string, unknown>
    attrs['status'] = 'refunded'
    attrs['refunded'] = true
    attrs['refunded_amount'] = 6049
    const event = normalizeOne(lemonSqueezyEvent('subscription_payment_refunded', invoice))
    expect(event.observations[0]?.normalized.status).toBe('refunded')
  })
})

describe('normalizeEvent — envelope & lifecycle events', () => {
  it('understands subscription lifecycle events as carrying no money of their own', () => {
    for (const eventName of [
      'subscription_created',
      'subscription_updated',
      'subscription_cancelled',
      'subscription_resumed',
      'subscription_expired',
      'subscription_paused',
      'subscription_unpaused',
      'license_key_created',
      'customer_updated',
    ]) {
      const event = normalizeOne(
        lemonSqueezyEvent(eventName, { type: 'subscriptions', id: 'sub_1' }),
      )
      expect(event.ignored).toBe('no_observations')
      expect(event.observations).toHaveLength(0)
    }
  })

  it('acks unhandled event types with unhandled_event_type', () => {
    const event = normalizeOne(lemonSqueezyEvent('unknown_future_event', { id: 'x' }))
    expect(event.ignored).toBe('unhandled_event_type')
  })

  it('refuses malformed events missing meta or data', () => {
    const outcome = adapter.normalizeEvent({ hello: 'world' }, { headers: HEADERS })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('malformed_event')
    }
  })
})

describe('verifyWebhook', () => {
  const SECRET = 'lemon_webhook_secret_12345'

  it('accepts a delivery signed with the secret', () => {
    const body = JSON.stringify({ hello: 'world' })
    const headers = signLemonSqueezyWebhook({ payload: body, secret: SECRET })
    const outcome = adapter.verifyWebhook({
      rawBody: body,
      signatureHeader: headers['x-signature'],
      headers,
      signingSecret: SECRET,
    })
    expect(outcome.ok).toBe(true)
  })

  it('refuses a delivery with wrong signature', () => {
    const body = JSON.stringify({ hello: 'world' })
    const headers = signLemonSqueezyWebhook({ payload: body, secret: 'wrong_secret' })
    const outcome = adapter.verifyWebhook({
      rawBody: body,
      signatureHeader: headers['x-signature'],
      headers,
      signingSecret: SECRET,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('no_matching_signature')
    }
  })

  it('refuses a delivery with missing signature header', () => {
    const outcome = adapter.verifyWebhook({
      rawBody: '{}',
      signatureHeader: undefined,
      headers: {},
      signingSecret: SECRET,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('malformed_header')
    }
  })
})

describe('verifyCredential', () => {
  it('probes orders with page[size]=1', async () => {
    let requestedUrl = ''
    let authHeader = ''
    const client = createLemonSqueezyRevenueAdapter(async (input, init) => {
      requestedUrl = String(input)
      authHeader = (init?.headers as Record<string, string>)?.['authorization'] ?? ''
      return jsonResponse({ data: [] })
    })

    const outcome = await client.verifyCredential('ls_test_api_key_123')
    expect(outcome).toEqual({ outcome: 'ok' })
    expect(requestedUrl).toContain('/orders?page[size]=1')
    expect(authHeader).toBe('Bearer ls_test_api_key_123')
  })

  it('reports 401 as unauthorized', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => new Response('{}', { status: 401 }))
    const outcome = await client.verifyCredential('ls_bad_key')
    expect(outcome.outcome).toBe('unauthorized')
  })

  it('reports 429 and 500 as unavailable', async () => {
    const client429 = createLemonSqueezyRevenueAdapter(
      async () => new Response('{}', { status: 429 }),
    )
    expect((await client429.verifyCredential('k')).outcome).toBe('unavailable')

    const client500 = createLemonSqueezyRevenueAdapter(
      async () => new Response('{}', { status: 500 }),
    )
    expect((await client500.verifyCredential('k')).outcome).toBe('unavailable')
  })

  it('reports network throw as unavailable rather than throwing', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => {
      throw new Error('network down')
    })
    const outcome = await client.verifyCredential('k')
    expect(outcome.outcome).toBe('unavailable')
  })
})

describe('listObjects', () => {
  it('lists charges paginated with sort=createdAt', async () => {
    let requestedUrl = ''
    const client = createLemonSqueezyRevenueAdapter(async (input) => {
      requestedUrl = String(input)
      return jsonResponse({
        meta: {
          page: {
            currentPage: 1,
            lastPage: 2,
            total: 2,
          },
        },
        links: {
          next: 'https://api.lemonsqueezy.com/v1/orders?page[number]=2',
        },
        data: [lemonSqueezyOrder()],
      })
    })

    const outcome = await client.listObjects('ls_key', 'charges', {
      cursor: null,
      pageSize: 20,
      windowStart: new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: new Date('2026-08-01T00:00:00.000Z'),
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.page.observations).toHaveLength(1)
      expect(outcome.page.observations[0]?.objectId).toBe('ord_test_1')
      expect(outcome.page.hasMore).toBe(true)
      expect(outcome.page.nextCursor).toBe('2')
    }
    expect(requestedUrl).toContain('page%5Bnumber%5D=1')
    expect(requestedUrl).toContain('page%5Bsize%5D=20')
    expect(requestedUrl).toContain('sort=createdAt')
  })

  it('refunds and disputes return empty page with hasMore=false', async () => {
    const client = createLemonSqueezyRevenueAdapter()
    for (const resource of ['refunds', 'disputes'] as const) {
      const outcome = await client.listObjects('ls_key', resource, {
        cursor: null,
        pageSize: 100,
        windowStart: new Date('2026-07-01T00:00:00.000Z'),
        windowEnd: new Date('2026-08-01T00:00:00.000Z'),
      })
      expect(outcome).toEqual({
        ok: true,
        page: { observations: [], nextCursor: null, hasMore: false },
      })
    }
  })
})

describe('fetchObject', () => {
  it('reads an order authoritatively by id', async () => {
    let requestedUrl = ''
    const client = createLemonSqueezyRevenueAdapter(async (input) => {
      requestedUrl = String(input)
      return jsonResponse({
        data: lemonSqueezyOrder({ id: 'ord_99' }),
      })
    })

    const outcome = await client.fetchObject('ls_key', 'charge', 'ord_99')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.observation?.objectId).toBe('ord_99')
    }
    expect(requestedUrl).toContain('/orders/ord_99')
  })

  it('answers 404 as missing: true', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => new Response('{}', { status: 404 }))
    const outcome = await client.fetchObject('ls_key', 'charge', 'ord_missing')
    expect(outcome).toEqual({ ok: true, observation: null, missing: true })
  })

  it('answers non-charge object kinds as missing: true', async () => {
    const client = createLemonSqueezyRevenueAdapter()
    const outcome = await client.fetchObject('ls_key', 'refund', 'ref_1')
    expect(outcome).toEqual({ ok: true, observation: null, missing: true })
  })
})
