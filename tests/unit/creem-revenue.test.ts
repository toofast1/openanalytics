import {
  CREEM_API_BASE,
  CREEM_TEST_API_BASE,
  createCreemRevenueAdapter,
  verifyHexHmacSignature,
} from '@openanalytics/integrations'
import { signCreemWebhook } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'
import {
  creemCheckout,
  creemDispute,
  creemEvent,
  creemRefund,
  creemSubscription,
  creemTransaction,
} from '../support/revenue-fixtures.ts'

/**
 * The Creem revenue adapter's semantics (ADR-0033, D1/D4/D5/D6).
 *
 * What only exists because Creem reports one payment through several envelopes:
 *
 * 1. **The charge is the transaction.** `checkout.completed` and the first
 *    `subscription.paid` name the same `tran_…` and land on one head.
 * 2. **The checkout id travels as a hint**, so a later `subscription.paid`
 *    cannot erase the `ch_…` a success page sends as `order_id`.
 * 3. **The amount is `amount_paid - tax_amount`.** A merchant of record.
 * 4. **A refund is derived from the transaction** on both paths, and never from
 *    a charge-back, whose money the dispute already carries.
 */

const adapter = createCreemRevenueAdapter()

function normalizeOne(event: Record<string, unknown>) {
  const outcome = adapter.normalizeEvent(event, { headers: {} })
  if (!outcome.ok) throw new Error(`normalize failed: ${outcome.reason}`)
  return outcome.event
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('normalizeEvent — checkout.completed', () => {
  it('reads the order as a charge keyed on its transaction, net of tax', () => {
    const event = normalizeOne(creemEvent('checkout.completed', creemCheckout()))
    expect(event.eventId).toBe('evt_test_1')
    expect(event.observations).toHaveLength(1)
    expect(event.observations[0]).toMatchObject({ objectId: 'tran_test_1', objectKind: 'charge' })
    expect(event.observations[0]?.normalized).toMatchObject({
      status: 'succeeded',
      livemode: true,
      currency: 'eur',
      gross_minor: 1000,
      order_id: 'ord_test_1',
      checkout_session_id: 'ch_test_1',
      client_reference_id: 'site_user_1',
      customer_id: 'cust_test_1',
      subscription_id: 'sub_test_1',
      product_id: 'prod_test_1',
      product_name: 'Monthly',
    })
  })

  it('also emits the checkout as a hint keyed on the order', () => {
    const event = normalizeOne(creemEvent('checkout.completed', creemCheckout()))
    expect(event.hints).toEqual([
      {
        checkoutSessionId: 'ch_test_1',
        orderId: 'ord_test_1',
        clientReferenceId: 'site_user_1',
        customerId: 'cust_test_1',
        occurredAt: new Date('2026-07-31T10:00:05.000Z'),
      },
    ])
  })

  it('prefers the customer external_id, then oa_external_id, then userId', () => {
    const external = normalizeOne(
      creemEvent(
        'checkout.completed',
        creemCheckout({ customer: { id: 'cust_test_1', external_id: 'ext_9' } }),
      ),
    )
    expect(external.observations[0]?.normalized.client_reference_id).toBe('ext_9')
    const oa = normalizeOne(
      creemEvent(
        'checkout.completed',
        creemCheckout({ metadata: { oa_external_id: 'oa_7', userId: 'user_1' } }),
      ),
    )
    expect(oa.observations[0]?.normalized.client_reference_id).toBe('oa_7')
  })

  it('never stores the customer email or name', () => {
    const event = normalizeOne(creemEvent('checkout.completed', creemCheckout()))
    const stored = JSON.stringify([event.observations, event.hints])
    expect(stored).not.toContain('buyer@example.com')
    expect(stored).not.toContain('Test Buyer')
  })

  it('times the observation by the event', () => {
    const event = normalizeOne(creemEvent('checkout.completed', creemCheckout()))
    expect(event.eventAt.toISOString()).toBe('2026-07-31T10:00:05.000Z')
    expect(event.observations[0]?.snapshotAt.toISOString()).toBe('2026-07-31T10:00:05.000Z')
  })
})

describe('normalizeEvent — subscription.paid', () => {
  it('lands the first payment on the same head as its checkout', () => {
    const fromCheckout = normalizeOne(creemEvent('checkout.completed', creemCheckout()))
    const fromSubscription = normalizeOne(
      creemEvent('subscription.paid', creemSubscription(), { id: 'evt_test_2' }),
    )
    expect(fromSubscription.observations[0]?.objectId).toBe(fromCheckout.observations[0]?.objectId)
    expect(fromSubscription.observations[0]?.normalized).toMatchObject({
      gross_minor: 1000,
      order_id: 'ord_test_1',
      // Unknown here — the projection takes it from the checkout's hint.
      checkout_session_id: '',
      // The transaction's own customer is null on this event; the
      // subscription's is read instead.
      customer_id: 'cust_test_1',
      client_reference_id: 'site_user_1',
    })
  })

  it('reads a renewal as a charge of its own', () => {
    const renewal = creemSubscription({
      last_transaction: creemTransaction({
        id: 'tran_test_2',
        order: 'ord_test_2',
        customer: null,
      }),
    })
    const event = normalizeOne(creemEvent('subscription.paid', renewal))
    expect(event.observations[0]).toMatchObject({ objectId: 'tran_test_2' })
    expect(event.observations[0]?.normalized.order_id).toBe('ord_test_2')
  })

  it.each([
    ['partialRefund', 'partially_refunded'],
    ['refunded', 'refunded'],
    ['chargedBack', 'charged_back'],
    ['declined', 'failed'],
    ['uncollectible', 'failed'],
    ['void', 'canceled'],
    ['pending', 'pending'],
  ])('maps a %s transaction to %s', (status, expected) => {
    const event = normalizeOne(
      creemEvent(
        'subscription.paid',
        creemSubscription({ last_transaction: creemTransaction({ status, customer: null }) }),
      ),
    )
    expect(event.observations[0]?.normalized.status).toBe(expected)
  })

  it.each([
    ['a fractional payment', { amount_paid: 1210.5 }],
    ['a tax larger than the payment', { tax_amount: 5000 }],
    ['no currency', { currency: null }],
  ])('refuses %s instead of guessing', (_label, overrides) => {
    const event = normalizeOne(
      creemEvent(
        'subscription.paid',
        creemSubscription({ last_transaction: creemTransaction({ ...overrides, customer: null }) }),
      ),
    )
    expect(event.ignored).toBe('unsupported_object_shape')
  })

  it('reads a zero payment as zero revenue whatever the tax', () => {
    const event = normalizeOne(
      creemEvent(
        'subscription.paid',
        creemSubscription({
          last_transaction: creemTransaction({ amount_paid: 0, tax_amount: 40, customer: null }),
        }),
      ),
    )
    expect(event.observations[0]?.normalized.gross_minor).toBe(0)
  })
})

describe('normalizeEvent — refunds and disputes', () => {
  it('derives a refund keyed on the transaction, dated by the refund', () => {
    const event = normalizeOne(creemEvent('refund.created', creemRefund()))
    const refund = event.observations.find((o) => o.objectKind === 'refund')
    const charge = event.observations.find((o) => o.objectKind === 'charge')
    expect(refund).toMatchObject({ objectId: 'tran_test_1:refund' })
    expect(refund?.normalized).toMatchObject({
      gross_minor: 500,
      parent_object_id: 'tran_test_1',
      order_id: 'ord_test_1',
      occurred_at: '2026-08-02T09:00:00.000Z',
    })
    // D2d: the charge keeps its full gross.
    expect(charge?.normalized).toMatchObject({ status: 'partially_refunded', gross_minor: 1000 })
  })

  it('opens a dispute and derives no refund from the charge-back', () => {
    const event = normalizeOne(creemEvent('dispute.created', creemDispute()))
    expect(event.observations).toHaveLength(1)
    expect(event.observations[0]).toMatchObject({ objectId: 'disp_test_1', objectKind: 'dispute' })
    expect(event.observations[0]?.normalized).toMatchObject({
      status: 'opened',
      gross_minor: 1210,
      parent_object_id: 'tran_test_1',
    })
  })
})

describe('normalizeEvent — the envelope', () => {
  it('refuses an event with no id rather than inventing one', () => {
    const outcome = adapter.normalizeEvent(
      creemEvent('checkout.completed', creemCheckout(), { id: undefined }),
      { headers: {} },
    )
    expect(outcome).toEqual({ ok: false, reason: 'malformed_event' })
  })

  it('understands the subscription lifecycle as carrying no money', () => {
    const event = normalizeOne(creemEvent('subscription.canceled', creemSubscription()))
    expect(event.ignored).toBe('no_observations')
  })

  it('acks an event type it does not read', () => {
    const event = normalizeOne(creemEvent('credits.granted', { object: 'credit' }))
    expect(event.ignored).toBe('unhandled_event_type')
  })

  it('refuses an object that does not match the event', () => {
    const event = normalizeOne(creemEvent('refund.created', creemCheckout()))
    expect(event.ignored).toBe('unsupported_object_shape')
  })

  it('reports livemode false for an adapter pointed at the sandbox', () => {
    const sandbox = createCreemRevenueAdapter(fetch, CREEM_TEST_API_BASE)
    const outcome = sandbox.normalizeEvent(creemEvent('checkout.completed', creemCheckout()), {
      headers: {},
    })
    expect(outcome.ok && outcome.event.observations[0]?.normalized.livemode).toBe(false)
  })
})

describe('verifyWebhook', () => {
  const secret = 'whsec_creem_test'
  const body = JSON.stringify(creemEvent('checkout.completed', creemCheckout()))

  it('accepts a delivery signed with the secret', () => {
    const headers = signCreemWebhook({ payload: body, secret })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: secret,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses one signed under another secret', () => {
    const headers = signCreemWebhook({ payload: body, secret: 'other' })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: undefined,
        headers,
        signingSecret: secret,
      }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('refuses a malformed header without throwing', () => {
    expect(verifyHexHmacSignature({ rawBody: body, header: 'z'.repeat(64), secret })).toEqual({
      ok: false,
      reason: 'malformed_header',
    })
  })
})

describe('verifyCredential', () => {
  it('probes one transaction with the x-api-key header', async () => {
    const calls: { url: string; key: string | null }[] = []
    const client = createCreemRevenueAdapter(async (input, init) => {
      calls.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') })
      return jsonResponse({ items: [], pagination: {} })
    })
    expect(await client.verifyCredential('creem_key')).toEqual({ outcome: 'ok' })
    expect(calls).toEqual([
      { url: `${CREEM_API_BASE}/v1/transactions/search?page_size=1`, key: 'creem_key' },
    ])
  })

  it('reports a rejected key as the customer’s problem', async () => {
    const client = createCreemRevenueAdapter(async () => new Response('{}', { status: 401 }))
    expect(await client.verifyCredential('creem_key')).toMatchObject({ outcome: 'unauthorized' })
  })

  it.each([429, 503])('reports a %s as Creem’s problem', async (status) => {
    const client = createCreemRevenueAdapter(async () => new Response('{}', { status }))
    expect(await client.verifyCredential('creem_key')).toMatchObject({ outcome: 'unavailable' })
  })
})

describe('listObjects', () => {
  const window = {
    windowStart: new Date('2026-07-01T00:00:00.000Z'),
    windowEnd: new Date('2026-08-31T23:59:59.999Z'),
    pageSize: 100,
  }

  it('walks transactions by page and follows next_page', async () => {
    const urls: string[] = []
    const client = createCreemRevenueAdapter(async (input) => {
      urls.push(String(input))
      return jsonResponse({
        items: [creemTransaction()],
        pagination: {
          current_page: 1,
          next_page: 2,
          total_pages: 3,
          total_records: 3,
          prev_page: null,
        },
      })
    })
    const outcome = await client.listObjects('creem_key', 'charges', { ...window, cursor: null })
    expect(outcome.ok && outcome.page).toMatchObject({ hasMore: true, nextCursor: '2' })
    expect(outcome.ok && outcome.page.observations[0]?.objectId).toBe('tran_test_1')
    expect(urls[0]).toBe(`${CREEM_API_BASE}/v1/transactions/search?page_number=1&page_size=100`)
  })

  it('ends when next_page is null', async () => {
    const client = createCreemRevenueAdapter(async () =>
      jsonResponse({ items: [], pagination: { current_page: 3, next_page: null } }),
    )
    const outcome = await client.listObjects('creem_key', 'charges', { ...window, cursor: '3' })
    expect(outcome.ok && outcome.page).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('derives refunds but never from a charge-back', async () => {
    const client = createCreemRevenueAdapter(async () =>
      jsonResponse({
        items: [
          creemTransaction({ id: 'tran_a', status: 'partialRefund', refunded_amount: 300 }),
          creemTransaction({ id: 'tran_b', status: 'chargedBack', refunded_amount: 1210 }),
        ],
        pagination: { next_page: null },
      }),
    )
    const outcome = await client.listObjects('creem_key', 'charges', { ...window, cursor: null })
    expect(outcome.ok && outcome.page.observations.map((o) => o.objectId)).toEqual([
      'tran_a',
      'tran_a:refund',
      'tran_b',
    ])
  })

  it('filters by the window in memory', async () => {
    const client = createCreemRevenueAdapter(async () =>
      jsonResponse({
        items: [creemTransaction({ created_at: Date.parse('2026-05-01T00:00:00.000Z') })],
        pagination: { next_page: null },
      }),
    )
    const outcome = await client.listObjects('creem_key', 'charges', { ...window, cursor: null })
    expect(outcome.ok && outcome.page.observations).toEqual([])
  })

  it('answers refunds and disputes with one empty final page', async () => {
    const client = createCreemRevenueAdapter(async () => {
      throw new Error('must not be called')
    })
    for (const resource of ['refunds', 'disputes'] as const) {
      expect(await client.listObjects('creem_key', resource, { ...window, cursor: null })).toEqual({
        ok: true,
        page: { observations: [], nextCursor: null, hasMore: false },
      })
    }
  })

  it('calls an unreadable cursor invalid', async () => {
    const client = createCreemRevenueAdapter(async () => jsonResponse({ items: [] }))
    const outcome = await client.listObjects('creem_key', 'charges', { ...window, cursor: 'x' })
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_cursor' })
  })
})

describe('fetchObject', () => {
  it('reads a transaction by id', async () => {
    const urls: string[] = []
    const client = createCreemRevenueAdapter(async (input) => {
      urls.push(String(input))
      return jsonResponse(creemTransaction())
    })
    const outcome = await client.fetchObject('creem_key', 'charge', 'tran_test_1')
    expect(outcome.ok && outcome.observation?.objectId).toBe('tran_test_1')
    expect(urls).toEqual([`${CREEM_API_BASE}/v1/transactions?transaction_id=tran_test_1`])
  })

  it('reads a derived refund through its transaction', async () => {
    const client = createCreemRevenueAdapter(async () =>
      jsonResponse(creemTransaction({ status: 'refunded', refunded_amount: 1210 })),
    )
    const outcome = await client.fetchObject('creem_key', 'refund', 'tran_test_1:refund')
    expect(outcome.ok && outcome.observation?.normalized.gross_minor).toBe(1210)
  })

  it('answers a dispute and a 404 as missing', async () => {
    const client = createCreemRevenueAdapter(async () => new Response('{}', { status: 404 }))
    expect(await client.fetchObject('creem_key', 'dispute', 'disp_1')).toEqual({
      ok: true,
      observation: null,
      missing: true,
    })
    expect(await client.fetchObject('creem_key', 'charge', 'tran_x')).toEqual({
      ok: true,
      observation: null,
      missing: true,
    })
  })
})
