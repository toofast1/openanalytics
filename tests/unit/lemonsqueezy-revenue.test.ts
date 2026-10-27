import {
  LEMONSQUEEZY_API_BASE,
  LEMONSQUEEZY_LIST_PAGE_SIZE,
  LEMONSQUEEZY_REVENUE_PROVIDER_ID,
  createLemonSqueezyRevenueAdapter,
  verifyLemonSqueezySignature,
} from '@openanalytics/integrations'
import { signLemonSqueezyWebhook } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import {
  lemonSqueezyEvent,
  lemonSqueezyOrder,
  lemonSqueezySubscriptionInvoice,
} from '../support/revenue-fixtures.ts'

/**
 * The Lemon Squeezy revenue adapter's semantics (ADR-0033, D1/D4/D5).
 *
 * The Polar and Dodo suites' twin, plus what only exists because Lemon Squeezy
 * shapes money differently from the port:
 *
 * 1. **The amount is `total - tax`.** A merchant of record.
 * 2. **A refund is a derived object.** The rollup subtracts only through a refund
 *    object, and Lemon Squeezy has none — so a refunded charge brings one.
 * 3. **A new subscription's first payment counts once**, although Lemon Squeezy
 *    reports it as both an order and an `initial` invoice.
 * 4. **Invoice ids are prefixed**, because order 7 and invoice 7 are different
 *    objects and the object head is keyed without the kind.
 * 5. **The ledger key is derived**, because deliveries carry no event id.
 * 6. **The signature check never throws**, whatever the header holds.
 */

const adapter = createLemonSqueezyRevenueAdapter()

function normalizeOne(event: Record<string, unknown>) {
  const outcome = adapter.normalizeEvent(event, { headers: {} })
  if (!outcome.ok) throw new Error(`normalize failed: ${outcome.reason}`)
  return outcome.event
}

function order(attributes: Record<string, unknown> = {}, id = '1001') {
  const base = lemonSqueezyOrder()
  return { ...base, id, attributes: { ...(base['attributes'] as object), ...attributes } }
}

function invoice(attributes: Record<string, unknown> = {}, id = '2002') {
  const base = lemonSqueezySubscriptionInvoice()
  return { ...base, id, attributes: { ...(base['attributes'] as object), ...attributes } }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/vnd.api+json' },
    ...init,
  })
}

function listPage(data: unknown[], page: { currentPage: number; lastPage: number }) {
  return { data, meta: { page: { ...page, perPage: 100 } }, links: {} }
}

describe('adapter metadata', () => {
  it('exposes the provider id, base URL and page size', () => {
    expect(LEMONSQUEEZY_REVENUE_PROVIDER_ID).toBe('lemonsqueezy')
    expect(LEMONSQUEEZY_API_BASE).toBe('https://api.lemonsqueezy.com/v1')
    expect(LEMONSQUEEZY_LIST_PAGE_SIZE).toBe(100)
  })
})

describe('normalizeEvent — orders become charges', () => {
  it('reads order_created net of the tax Lemon Squeezy remits', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', order()))
    expect(event.observations).toHaveLength(1)
    expect(event.observations[0]).toMatchObject({ objectId: '1001', objectKind: 'charge' })
    expect(event.observations[0]?.normalized).toMatchObject({
      status: 'succeeded',
      livemode: true,
      currency: 'usd',
      gross_minor: 4999,
      net_minor: 4999,
      fee_currency: '',
      order_id: '1001',
      client_reference_id: 'site_user_1',
      customer_id: '101',
      product_id: '201',
      product_name: 'Pro Subscription',
    })
  })

  it('never stores the customer email or name it was sent', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', order()))
    const stored = JSON.stringify(event.observations)
    expect(stored).not.toContain('buyer@example.com')
    expect(stored).not.toContain('Test Buyer')
  })

  it('stores a null customer id as empty, never as the word "null"', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', order({ customer_id: null })))
    expect(event.observations[0]?.normalized.customer_id).toBe('')
  })

  it('reads a zero-total order as zero revenue whatever tax says', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', order({ total: 0, tax: 120 })))
    expect(event.observations[0]?.normalized.gross_minor).toBe(0)
  })

  it.each([
    ['a fractional total', { total: 6049.5 }],
    ['a tax larger than the total', { tax: 7000 }],
    ['a missing tax field', { tax: undefined }],
  ])('refuses %s instead of guessing', (_label, attributes) => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', order(attributes)))
    expect(event.ignored).toBe('unsupported_object_shape')
  })

  it.each([
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['fraudulent', 'failed'],
    ['partial_refund', 'partially_refunded'],
  ])('maps an order status %s to %s', (status, expected) => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', order({ status })))
    expect(event.observations[0]?.normalized.status).toBe(expected)
  })

  it('reports livemode false for a test-mode order', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', order({ test_mode: true })))
    expect(event.observations[0]?.normalized.livemode).toBe(false)
  })
})

describe('normalizeEvent — refunds are derived objects', () => {
  it('brings a refund object for a partially refunded order, and keeps the gross', () => {
    const event = normalizeOne(
      lemonSqueezyEvent(
        'order_refunded',
        order({
          status: 'partial_refund',
          refunded_amount: 1500,
          updated_at: '2026-08-02T09:00:00.000000Z',
        }),
      ),
    )
    expect(event.observations).toHaveLength(2)
    const [charge, refund] = event.observations
    // D2d: the charge keeps its FULL gross; the refund carries the negative.
    expect(charge?.normalized).toMatchObject({ status: 'partially_refunded', gross_minor: 4999 })
    expect(refund).toMatchObject({ objectId: '1001:refund', objectKind: 'refund' })
    expect(refund?.normalized).toMatchObject({
      status: 'succeeded',
      gross_minor: 1500,
      parent_object_id: '1001',
      occurred_at: '2026-08-02T09:00:00.000Z',
    })
  })

  it('dates a full refund by refunded_at', () => {
    const event = normalizeOne(
      lemonSqueezyEvent(
        'order_refunded',
        order({
          status: 'refunded',
          refunded: true,
          refunded_amount: 6049,
          refunded_at: '2026-08-03T10:00:00.000000Z',
          updated_at: '2026-08-03T10:00:01.000000Z',
        }),
      ),
    )
    expect(event.observations[0]?.normalized.status).toBe('refunded')
    expect(event.observations[1]?.normalized.occurred_at).toBe('2026-08-03T10:00:00.000Z')
  })

  it('promotes a paid charge carrying a refunded amount', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('subscription_payment_refunded', invoice({ refunded_amount: 100 })),
    )
    expect(event.observations[0]?.normalized.status).toBe('partially_refunded')
    expect(event.observations[1]?.objectId).toBe('invoice:2002:refund')
  })
})

describe('normalizeEvent — subscription invoices', () => {
  it('reads a renewal as a charge under a prefixed id', () => {
    const event = normalizeOne(lemonSqueezyEvent('subscription_payment_success', invoice()))
    expect(event.observations[0]).toMatchObject({ objectId: 'invoice:2002', objectKind: 'charge' })
    expect(event.observations[0]?.normalized).toMatchObject({
      status: 'succeeded',
      gross_minor: 4999,
      subscription_id: '501',
      order_id: 'invoice:2002',
    })
  })

  it('keeps order 7 and invoice 7 apart', () => {
    const fromOrder = normalizeOne(lemonSqueezyEvent('order_created', order({}, '7')))
    const fromInvoice = normalizeOne(
      lemonSqueezyEvent('subscription_payment_success', invoice({}, '7')),
    )
    expect(fromOrder.observations[0]?.objectId).not.toBe(fromInvoice.observations[0]?.objectId)
  })

  it('does not count the initial invoice, which is the same money as its order', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('subscription_payment_success', invoice({ billing_reason: 'initial' })),
    )
    expect(event.observations).toHaveLength(0)
    expect(event.ignored).toBe('no_observations')
  })

  it('reads a failed renewal, whose invoice stays pending, as failed', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('subscription_payment_failed', invoice({ status: 'pending' })),
    )
    expect(event.observations[0]?.normalized.status).toBe('failed')
  })

  it('reads a void invoice as canceled', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('subscription_payment_success', invoice({ status: 'void' })),
    )
    expect(event.observations[0]?.normalized.status).toBe('canceled')
  })
})

describe('normalizeEvent — the envelope', () => {
  it('derives a ledger key that a redelivery repeats and a change moves', () => {
    const first = normalizeOne(lemonSqueezyEvent('order_created', order()))
    const again = normalizeOne(lemonSqueezyEvent('order_created', order()))
    const later = normalizeOne(
      lemonSqueezyEvent('order_refunded', order({ updated_at: '2026-08-02T09:00:00.000000Z' })),
    )
    expect(first.eventId).toBe(again.eventId)
    expect(first.eventId).not.toBe(later.eventId)
  })

  it('orders a delivery by the object’s last change', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('order_refunded', order({ updated_at: '2026-08-02T09:00:00.000000Z' })),
    )
    expect(event.eventAt.toISOString()).toBe('2026-08-02T09:00:00.000Z')
    expect(event.observations[0]?.snapshotAt.toISOString()).toBe('2026-08-02T09:00:00.000Z')
  })

  it('refuses a delivery with no timestamp rather than inventing one', () => {
    const outcome = adapter.normalizeEvent(
      lemonSqueezyEvent('order_created', order({ created_at: null, updated_at: null })),
      { headers: {} },
    )
    expect(outcome).toEqual({ ok: false, reason: 'malformed_event' })
  })

  it('understands lifecycle events as carrying no money', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('subscription_created', {
        type: 'subscriptions',
        id: '9',
        attributes: { updated_at: '2026-08-01T00:00:00Z' },
      }),
    )
    expect(event.ignored).toBe('no_observations')
  })

  it('acks an event type it does not read', () => {
    const event = normalizeOne(
      lemonSqueezyEvent('affiliate_activated', {
        type: 'affiliates',
        id: '3',
        attributes: { updated_at: '2026-08-01T00:00:00Z' },
      }),
    )
    expect(event.ignored).toBe('unhandled_event_type')
  })

  it('refuses data whose type does not match the event', () => {
    const event = normalizeOne(lemonSqueezyEvent('order_created', invoice()))
    expect(event.ignored).toBe('unsupported_object_shape')
  })
})

describe('verifyWebhook', () => {
  const secret = 'ls_signing_secret'
  const body = JSON.stringify(lemonSqueezyEvent('order_created', order()))

  it('accepts a delivery signed with the secret', () => {
    const headers = signLemonSqueezyWebhook({ payload: body, secret })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: secret,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses a delivery signed under another secret', () => {
    const headers = signLemonSqueezyWebhook({ payload: body, secret: 'another' })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: secret,
      }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it.each([
    ['missing', undefined],
    ['64 characters that are not all hex', `${'a'.repeat(63)}z`],
    ['too short', 'abc123'],
  ])('refuses a %s header without throwing', (_label, header) => {
    expect(verifyLemonSqueezySignature({ rawBody: body, header, secret })).toEqual({
      ok: false,
      reason: 'malformed_header',
    })
  })
})

describe('verifyCredential', () => {
  it('probes one order', async () => {
    const urls: string[] = []
    const client = createLemonSqueezyRevenueAdapter(async (input) => {
      urls.push(String(input))
      return jsonResponse({ data: [] })
    })
    expect(await client.verifyCredential('ls_key')).toEqual({ outcome: 'ok' })
    expect(urls).toEqual(['https://api.lemonsqueezy.com/v1/orders?page[size]=1'])
  })

  it('reports a rejected key as the customer’s problem', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => new Response('{}', { status: 401 }))
    expect(await client.verifyCredential('ls_key')).toMatchObject({ outcome: 'unauthorized' })
  })

  it.each([429, 503])('reports a %s as Lemon Squeezy’s problem', async (status) => {
    const client = createLemonSqueezyRevenueAdapter(async () => new Response('{}', { status }))
    expect(await client.verifyCredential('ls_key')).toMatchObject({ outcome: 'unavailable' })
  })

  it('reports a network failure as unavailable rather than throwing', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await client.verifyCredential('ls_key')).toMatchObject({ outcome: 'unavailable' })
  })
})

describe('listObjects', () => {
  const window = {
    windowStart: new Date('2026-07-01T00:00:00.000Z'),
    windowEnd: new Date('2026-08-31T23:59:59.999Z'),
    pageSize: 100,
  }

  it('walks orders, then invoices, and sends no sort parameter', async () => {
    const urls: string[] = []
    const client = createLemonSqueezyRevenueAdapter(async (input) => {
      const url = String(input)
      urls.push(url)
      return url.includes('/orders?')
        ? jsonResponse(listPage([order()], { currentPage: 1, lastPage: 1 }))
        : jsonResponse(listPage([invoice()], { currentPage: 1, lastPage: 1 }))
    })

    const first = await client.listObjects('ls_key', 'charges', { ...window, cursor: null })
    expect(first.ok && first.page).toMatchObject({ hasMore: true, nextCursor: 'invoices|1' })
    expect(first.ok && first.page.observations[0]?.objectId).toBe('1001')

    const second = await client.listObjects('ls_key', 'charges', {
      ...window,
      cursor: 'invoices|1',
    })
    expect(second.ok && second.page).toMatchObject({ hasMore: false, nextCursor: null })
    expect(second.ok && second.page.observations[0]?.objectId).toBe('invoice:2002')

    expect(urls[0]).toBe(
      'https://api.lemonsqueezy.com/v1/orders?page%5Bnumber%5D=1&page%5Bsize%5D=100',
    )
    expect(urls.every((url) => !url.includes('sort'))).toBe(true)
  })

  it('pages within a list while there is a next page', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () =>
      jsonResponse(listPage([order()], { currentPage: 1, lastPage: 3 })),
    )
    const outcome = await client.listObjects('ls_key', 'charges', { ...window, cursor: null })
    expect(outcome.ok && outcome.page.nextCursor).toBe('orders|2')
  })

  it('keeps a refund inside the window although its order is older', async () => {
    const old = order({
      created_at: '2026-05-01T00:00:00.000000Z',
      status: 'partial_refund',
      refunded_amount: 500,
      updated_at: '2026-08-10T00:00:00.000000Z',
    })
    const client = createLemonSqueezyRevenueAdapter(async () =>
      jsonResponse(listPage([old], { currentPage: 1, lastPage: 1 })),
    )
    const outcome = await client.listObjects('ls_key', 'charges', { ...window, cursor: null })
    expect(outcome.ok && outcome.page.observations.map((o) => o.objectId)).toEqual(['1001:refund'])
  })

  it('skips the initial invoice and pending renewals', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () =>
      jsonResponse(
        listPage([invoice({ billing_reason: 'initial' }), invoice({ status: 'pending' }, '2003')], {
          currentPage: 1,
          lastPage: 1,
        }),
      ),
    )
    const outcome = await client.listObjects('ls_key', 'charges', {
      ...window,
      cursor: 'invoices|1',
    })
    expect(outcome.ok && outcome.page.observations).toEqual([])
  })

  it('answers refunds and disputes with one empty final page', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => {
      throw new Error('must not be called')
    })
    for (const resource of ['refunds', 'disputes'] as const) {
      const outcome = await client.listObjects('ls_key', resource, { ...window, cursor: null })
      expect(outcome).toEqual({
        ok: true,
        page: { observations: [], nextCursor: null, hasMore: false },
      })
    }
  })

  it('calls an unreadable cursor invalid rather than restarting silently', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => jsonResponse({ data: [] }))
    const outcome = await client.listObjects('ls_key', 'charges', { ...window, cursor: '7' })
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_cursor' })
  })

  it('refuses a list response with no data array', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => jsonResponse({ meta: {} }))
    const outcome = await client.listObjects('ls_key', 'charges', { ...window, cursor: null })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' })
  })
})

describe('fetchObject — the tie-break path', () => {
  it('reads an invoice from the invoice endpoint', async () => {
    const urls: string[] = []
    const client = createLemonSqueezyRevenueAdapter(async (input) => {
      urls.push(String(input))
      return jsonResponse({ data: invoice() })
    })
    const outcome = await client.fetchObject('ls_key', 'charge', 'invoice:2002')
    expect(outcome.ok && outcome.observation?.objectId).toBe('invoice:2002')
    expect(urls).toEqual(['https://api.lemonsqueezy.com/v1/subscription-invoices/2002'])
  })

  it('reads a derived refund through its order', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () =>
      jsonResponse({ data: order({ status: 'partial_refund', refunded_amount: 700 }) }),
    )
    const outcome = await client.fetchObject('ls_key', 'refund', '1001:refund')
    expect(outcome.ok && outcome.observation?.normalized.gross_minor).toBe(700)
  })

  it('answers a 404 and a dispute as missing', async () => {
    const client = createLemonSqueezyRevenueAdapter(async () => new Response('{}', { status: 404 }))
    expect(await client.fetchObject('ls_key', 'charge', '1001')).toEqual({
      ok: true,
      observation: null,
      missing: true,
    })
    expect(await client.fetchObject('ls_key', 'dispute', 'x')).toEqual({
      ok: true,
      observation: null,
      missing: true,
    })
  })
})
