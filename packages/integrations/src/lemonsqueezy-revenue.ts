import {
  revenueObservationHash,
  type RevenueAdapter,
  type RevenueCredentialVerification,
  type RevenueFetchOutcome,
  type RevenueIgnoreReason,
  type RevenueListOptions,
  type RevenueListOutcome,
  type RevenueNormalizeOutcome,
  type RevenueNormalizedObject,
  type RevenueObjectKind,
  type RevenueObservation,
  type RevenueSyncResource,
  type RevenueWebhookVerification,
} from '@openanalytics/domain'
import { verifyLemonSqueezySignature } from './lemonsqueezy-signature.ts'

/**
 * The Lemon Squeezy revenue adapter.
 *
 * The fourth provider, following Stripe, Polar and Dodo:
 * an adapter and a catalog flip. No migration, no environment variable,
 * no OpenAPI change, no new grant.
 *
 * SDK-free: `fetch`, a typed outcome, and no third-party code on a path
 * carrying a customer's own key.
 *
 * Connection model: customer API key + webhook signing secret in the
 * two-step connect flow.
 *
 * ## Key semantics:
 * - **Merchant of Record**: tax is collected and remitted by Lemon Squeezy.
 *   The charge amount is `total - tax` (or `subtotal`), matching Polar's net_amount
 *   and Dodo's `total_amount - tax`.
 * - **Integer passthrough**: amounts in minor units (cents) are integers.
 *   Corrupted or fractional values are refused rather than rounded.
 * - **Secrets and PII**: customer email (`user_email`) is never recorded.
 * - **Signature verification**: HMAC-SHA256 hex digest under the raw body,
 *   transmitted in the `X-Signature` request header.
 */

export const LEMONSQUEEZY_REVENUE_PROVIDER_ID = 'lemonsqueezy'
export const LEMONSQUEEZY_API_BASE = 'https://api.lemonsqueezy.com/v1'

const PROBE_PATH = '/orders?page[size]=1'
const PROBE_TIMEOUT_MS = 10_000
const SYNC_TIMEOUT_MS = 30_000

export const LEMONSQUEEZY_LIST_PAGE_SIZE = 100

/**
 * Consumed event allowlist.
 */
const CONSUMED_EVENTS: Readonly<Record<string, 'order' | 'subscription_invoice' | null>> = {
  order_created: 'order',
  order_refunded: 'order',
  subscription_payment_success: 'subscription_invoice',
  subscription_payment_failed: 'subscription_invoice',
  subscription_payment_recovered: 'subscription_invoice',
  subscription_payment_refunded: 'subscription_invoice',
  // Subscription lifecycle events without money:
  subscription_created: null,
  subscription_updated: null,
  subscription_cancelled: null,
  subscription_resumed: null,
  subscription_expired: null,
  subscription_paused: null,
  subscription_unpaused: null,
  license_key_created: null,
  license_key_updated: null,
  customer_updated: null,
}

// --- Shape readers -----------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

function isoToDate(value: unknown): Date | null {
  const raw = asString(value)
  if (raw === null) return null
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : new Date(at)
}

function currencyOf(attrs: Record<string, unknown>): string | null {
  const raw = asString(attrs['currency'])
  return raw === null || raw === '' ? null : raw.toLowerCase()
}

function siteReference(
  meta: Record<string, unknown> | null,
  attrs: Record<string, unknown>,
): string {
  const customData = asRecord(meta?.['custom_data'])
  if (customData) {
    for (const key of ['oa_external_id', 'client_reference_id', 'user_id']) {
      const val = asString(customData[key])
      if (val !== null && val !== '') return val
    }
  }
  const orderCustom = asRecord(attrs['custom_data'])
  if (orderCustom) {
    for (const key of ['oa_external_id', 'client_reference_id', 'user_id']) {
      const val = asString(orderCustom[key])
      if (val !== null && val !== '') return val
    }
  }
  return ''
}

function snapshot(
  base: Pick<RevenueNormalizedObject, 'object_kind' | 'status' | 'livemode' | 'currency'>,
  gross: number,
  occurredAt: Date,
  refs: Partial<
    Pick<
      RevenueNormalizedObject,
      | 'parent_object_id'
      | 'order_id'
      | 'checkout_session_id'
      | 'client_reference_id'
      | 'subscription_id'
      | 'product_id'
      | 'product_name'
      | 'customer_id'
    >
  >,
): RevenueNormalizedObject {
  return {
    object_kind: base.object_kind,
    status: base.status,
    livemode: base.livemode,
    currency: base.currency,
    gross_minor: gross,
    fee_minor: 0,
    fee_currency: '',
    net_minor: gross,
    occurred_at: occurredAt.toISOString(),
    parent_object_id: refs.parent_object_id ?? '',
    order_id: refs.order_id ?? '',
    checkout_session_id: refs.checkout_session_id ?? '',
    client_reference_id: refs.client_reference_id ?? '',
    subscription_id: refs.subscription_id ?? '',
    product_id: refs.product_id ?? '',
    product_name: refs.product_name ?? '',
    customer_id: refs.customer_id ?? '',
  }
}

function orderStatus(attrs: Record<string, unknown>): string {
  const rawStatus = (asString(attrs['status']) ?? '').toLowerCase()
  const refunded = attrs['refunded'] === true || rawStatus === 'refunded'
  const refundedAmount = asInteger(attrs['refunded_amount']) ?? 0
  const total = asInteger(attrs['total']) ?? 0

  if (refunded) {
    if (refundedAmount > 0 && total > 0 && refundedAmount < total) {
      return 'partially_refunded'
    }
    return 'refunded'
  }
  if (rawStatus === 'paid') return 'succeeded'
  if (rawStatus === 'pending') return 'pending'
  if (rawStatus === 'failed') return 'failed'
  return rawStatus === '' ? 'pending' : rawStatus
}

function subscriptionInvoiceStatus(attrs: Record<string, unknown>): string {
  const rawStatus = (asString(attrs['status']) ?? '').toLowerCase()
  const refunded = attrs['refunded'] === true || rawStatus === 'refunded'
  const refundedAmount = asInteger(attrs['refunded_amount']) ?? 0
  const total = asInteger(attrs['total']) ?? 0

  if (refunded) {
    if (refundedAmount > 0 && total > 0 && refundedAmount < total) {
      return 'partially_refunded'
    }
    return 'refunded'
  }
  if (rawStatus === 'paid') return 'succeeded'
  if (rawStatus === 'pending') return 'pending'
  if (rawStatus === 'void') return 'canceled'
  if (rawStatus === 'uncollectible') return 'failed'
  return rawStatus === '' ? 'pending' : rawStatus
}

// --- Normalizers -------------------------------------------------------------

function normalizeLemonSqueezyOrder(
  data: Record<string, unknown>,
  meta: Record<string, unknown> | null,
  defaultLivemode: boolean,
): RevenueObservation | null {
  const objectId = asString(data['id'])
  const attrs = asRecord(data['attributes'])
  if (!objectId || !attrs) return null

  const currency = currencyOf(attrs)
  const total = asInteger(attrs['total'])
  const created = isoToDate(attrs['created_at'])
  if (currency === null || total === null || created === null) return null

  if (!('tax' in attrs)) return null
  const reportedTax = attrs['tax'] === null ? 0 : asInteger(attrs['tax'])
  if (reportedTax === null) return null
  const tax = total === 0 ? 0 : reportedTax
  if (tax < 0 || tax > total) return null

  const livemode =
    attrs['test_mode'] === true || meta?.['test_mode'] === true ? false : defaultLivemode

  const status = orderStatus(attrs)
  const firstItem = asRecord(attrs['first_order_item'])
  const productId = firstItem ? String(firstItem['product_id'] ?? '') : ''
  const productName = firstItem ? (asString(firstItem['product_name']) ?? '') : ''
  const customerId = attrs['customer_id'] !== undefined ? String(attrs['customer_id']) : ''
  const subscriptionId =
    attrs['subscription_id'] !== undefined ? String(attrs['subscription_id']) : ''

  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: created,
    normalized: snapshot(
      { object_kind: 'charge', status, livemode, currency },
      total - tax,
      created,
      {
        order_id: objectId,
        checkout_session_id: '',
        client_reference_id: siteReference(meta, attrs),
        customer_id: customerId,
        subscription_id: subscriptionId,
        product_id: productId,
        product_name: productName,
      },
    ),
  }
}

function normalizeLemonSqueezyInvoice(
  data: Record<string, unknown>,
  meta: Record<string, unknown> | null,
  defaultLivemode: boolean,
): RevenueObservation | null {
  const objectId = asString(data['id'])
  const attrs = asRecord(data['attributes'])
  if (!objectId || !attrs) return null

  const currency = currencyOf(attrs)
  const total = asInteger(attrs['total'])
  const created = isoToDate(attrs['created_at'])
  if (currency === null || total === null || created === null) return null

  if (!('tax' in attrs)) return null
  const reportedTax = attrs['tax'] === null ? 0 : asInteger(attrs['tax'])
  if (reportedTax === null) return null
  const tax = total === 0 ? 0 : reportedTax
  if (tax < 0 || tax > total) return null

  const livemode =
    attrs['test_mode'] === true || meta?.['test_mode'] === true ? false : defaultLivemode

  const status = subscriptionInvoiceStatus(attrs)
  const customerId = attrs['customer_id'] !== undefined ? String(attrs['customer_id']) : ''
  const subscriptionId =
    attrs['subscription_id'] !== undefined ? String(attrs['subscription_id']) : ''

  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: created,
    normalized: snapshot(
      { object_kind: 'charge', status, livemode, currency },
      total - tax,
      created,
      {
        order_id: objectId,
        checkout_session_id: '',
        client_reference_id: siteReference(meta, attrs),
        customer_id: customerId,
        subscription_id: subscriptionId,
        product_id: '',
        product_name: '',
      },
    ),
  }
}

// --- HTTP Helpers ------------------------------------------------------------

const MAX_RETRY_AFTER_MS = 300_000

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS)
}

interface LemonSqueezyGetSuccess {
  readonly ok: true
  readonly body: Record<string, unknown>
}

interface LemonSqueezyGetFailure {
  readonly ok: false
  readonly reason: 'unavailable' | 'unauthorized' | 'invalid_cursor'
  readonly detail: string
  readonly retryAfterMs?: number
  readonly missing?: boolean
}

async function lemonSqueezyGet(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  path: string,
  options: { readonly cursorSensitive?: boolean } = {},
): Promise<LemonSqueezyGetSuccess | LemonSqueezyGetFailure> {
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/vnd.api+json',
      },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'lemonsqueezy request did not complete' }
  }

  if (response.status === 429) {
    const after = retryAfterMs(response)
    return {
      ok: false,
      reason: 'unavailable',
      detail: 'lemonsqueezy responded 429',
      ...(after === undefined ? {} : { retryAfterMs: after }),
    }
  }
  if (response.status >= 500) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: `lemonsqueezy responded ${String(response.status)}`,
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'unauthorized',
      detail: `lemonsqueezy responded ${String(response.status)}`,
    }
  }

  const residual: LemonSqueezyGetFailure['reason'] =
    options.cursorSensitive === true ? 'invalid_cursor' : 'unauthorized'

  if (response.status === 404) {
    return { ok: false, reason: residual, detail: 'lemonsqueezy responded 404', missing: true }
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || asRecord(body) === null) {
    return {
      ok: false,
      reason: residual,
      detail: `lemonsqueezy responded ${String(response.status)}`,
    }
  }
  return { ok: true, body: body as Record<string, unknown> }
}

// --- The Adapter -------------------------------------------------------------

export function createLemonSqueezyRevenueAdapter(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = LEMONSQUEEZY_API_BASE,
): RevenueAdapter {
  return {
    providerId: LEMONSQUEEZY_REVENUE_PROVIDER_ID,

    async verifyCredential(secretKey: string): Promise<RevenueCredentialVerification> {
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${PROBE_PATH}`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${secretKey}`,
            accept: 'application/vnd.api+json',
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      } catch {
        return { outcome: 'unavailable', detail: 'lemonsqueezy probe did not complete' }
      }

      if (response.status === 429 || response.status >= 500) {
        return {
          outcome: 'unavailable',
          detail: `lemonsqueezy responded ${String(response.status)}`,
        }
      }
      if (!response.ok) {
        return {
          outcome: 'unauthorized',
          detail: `lemonsqueezy responded ${String(response.status)}`,
        }
      }

      return { outcome: 'ok' }
    },

    verifyWebhook(input): RevenueWebhookVerification {
      const header = input.headers?.['x-signature'] ?? input.signatureHeader
      return verifyLemonSqueezySignature({
        rawBody: input.rawBody,
        header,
        secret: input.signingSecret,
      })
    },

    normalizeEvent(parsedEvent: unknown, context): RevenueNormalizeOutcome {
      const event = asRecord(parsedEvent)
      const meta = asRecord(event?.['meta'])
      const eventType = meta ? asString(meta['event_name']) : null
      const data = asRecord(event?.['data'])
      const dataType = data ? asString(data['type']) : null
      const dataId = data ? asString(data['id']) : null
      const attrs = asRecord(data?.['attributes'])
      const eventAt =
        isoToDate(attrs?.['created_at']) ??
        isoToDate(attrs?.['updated_at']) ??
        isoToDate(meta?.['created_at']) ??
        isoToDate(event?.['created_at']) ??
        isoToDate(event?.['timestamp']) ??
        new Date()

      const eventId =
        context?.headers?.['webhook-id'] ??
        context?.headers?.['x-event-id'] ??
        context?.headers?.['x-signature'] ??
        (dataId && dataType && eventType
          ? `${eventType}:${dataType}:${dataId}:${asString(attrs?.['updated_at']) ?? asString(attrs?.['created_at']) ?? ''}`
          : null)

      if (!event || !eventType || !eventAt || !eventId) {
        return { ok: false, reason: 'malformed_event' }
      }

      const base = { eventId, eventType, eventAt }

      if (!(eventType in CONSUMED_EVENTS)) return ignored(base, 'unhandled_event_type')
      const target = CONSUMED_EVENTS[eventType]
      if (target === null || target === undefined) return ignored(base, 'no_observations')

      if (!data) return ignored(base, 'unsupported_object_shape')

      let observation: RevenueObservation | null = null
      if (target === 'order') {
        if (dataType !== 'orders') return ignored(base, 'unsupported_object_shape')
        observation = normalizeLemonSqueezyOrder(data, meta, true)
      } else if (target === 'subscription_invoice') {
        if (dataType !== 'subscription-invoices') return ignored(base, 'unsupported_object_shape')
        observation = normalizeLemonSqueezyInvoice(data, meta, true)
      }

      if (observation === null) return ignored(base, 'unsupported_object_shape')

      return {
        ok: true,
        event: {
          ...base,
          observations: [{ ...observation, snapshotAt: eventAt }],
        },
      }
    },

    async listObjects(
      secretKey: string,
      resource: RevenueSyncResource,
      options: RevenueListOptions,
    ): Promise<RevenueListOutcome> {
      if (resource !== 'charges') {
        return { ok: true, page: { observations: [], nextCursor: null, hasMore: false } }
      }

      let pageNumber = 1
      if (options.cursor !== null && options.cursor !== '') {
        const parsed = Number(options.cursor)
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return {
            ok: false,
            reason: 'invalid_cursor',
            detail: 'lemonsqueezy cursor is unreadable',
          }
        }
        pageNumber = parsed
      }

      const limit = Math.min(Math.max(options.pageSize, 1), LEMONSQUEEZY_LIST_PAGE_SIZE)
      const query = new URLSearchParams({
        'page[number]': String(pageNumber),
        'page[size]': String(limit),
        sort: 'createdAt',
      })

      const result = await lemonSqueezyGet(
        fetchImpl,
        baseUrl,
        secretKey,
        `/orders?${query.toString()}`,
        { cursorSensitive: options.cursor !== null && options.cursor !== '' },
      )
      if (!result.ok) return failure(result)

      const items = result.body['data']
      if (!Array.isArray(items)) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: 'lemonsqueezy list response has no data array',
        }
      }

      const observations: RevenueObservation[] = []
      let exceededWindow = false

      for (const row of items) {
        const data = asRecord(row)
        if (!data) continue

        const observation = normalizeLemonSqueezyOrder(data, null, true)
        if (observation === null) continue

        const createdAt = observation.snapshotAt.getTime()
        if (createdAt < options.windowStart.getTime()) {
          continue
        }
        if (createdAt > options.windowEnd.getTime()) {
          exceededWindow = true
          break
        }

        observations.push(observation)
      }

      const meta = asRecord(result.body['meta'])
      const pageMeta = asRecord(meta?.['page'])
      const lastPage = asInteger(pageMeta?.['lastPage'])
      const links = asRecord(result.body['links'])
      const hasNextLink = asString(links?.['next']) !== null

      const hasMore =
        !exceededWindow && (hasNextLink || (lastPage !== null && pageNumber < lastPage))
      const nextCursor = hasMore ? String(pageNumber + 1) : null

      return {
        ok: true,
        page: {
          observations,
          nextCursor,
          hasMore,
        },
      }
    },

    async fetchObject(
      secretKey: string,
      objectKind: RevenueObjectKind,
      objectId: string,
    ): Promise<RevenueFetchOutcome> {
      if (objectKind !== 'charge') {
        return { ok: true, observation: null, missing: true }
      }

      const result = await lemonSqueezyGet(
        fetchImpl,
        baseUrl,
        secretKey,
        `/orders/${encodeURIComponent(objectId)}`,
      )
      if (!result.ok) {
        if (result.missing === true) return { ok: true, observation: null, missing: true }
        return failure(result)
      }

      const data = asRecord(result.body['data'])
      if (!data) {
        return { ok: false, reason: 'unavailable', detail: 'lemonsqueezy object could not be read' }
      }

      const observation = normalizeLemonSqueezyOrder(data, null, true)
      if (observation === null) {
        return { ok: false, reason: 'unavailable', detail: 'lemonsqueezy object could not be read' }
      }

      return { ok: true, observation }
    },
  }
}

function ignored(
  base: { eventId: string; eventType: string; eventAt: Date },
  reason: RevenueIgnoreReason,
): RevenueNormalizeOutcome {
  return { ok: true, event: { ...base, observations: [], ignored: reason } }
}

function failure(result: LemonSqueezyGetFailure): RevenueListOutcome & RevenueFetchOutcome {
  return {
    ok: false,
    reason: result.reason,
    detail: result.detail,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  }
}

export { revenueObservationHash }
