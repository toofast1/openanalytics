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
 * The Lemon Squeezy revenue adapter (ADR-0033, D1/D4; the D9 follow-up row for
 * Lemon Squeezy).
 *
 * The fourth provider: an adapter and a catalog flip. No migration, no
 * environment variable, no OpenAPI change, no new grant. SDK-free like the
 * adapters beside it.
 *
 * ## Where Lemon Squeezy's model differs from the port's
 *
 * The port speaks of charges, refunds and disputes as separate objects with ids
 * of their own. Lemon Squeezy has none of that shape, and each mismatch is
 * answered here rather than in the pipeline:
 *
 * - **Money lives on two resources.** A one-time purchase *and the first payment
 *   of a subscription* are Orders; every later subscription payment is a
 *   Subscription Invoice. Both are charges.
 * - **The first subscription payment is reported twice.** Lemon Squeezy sends
 *   `order_created` alongside `subscription_created`, and then
 *   `subscription_payment_success` for the same money with an invoice whose
 *   `billing_reason` is `initial`. The order is the one kept; the initial invoice
 *   is understood and carries no money (`isDuplicateOfOrder`). Counting both
 *   would double every new subscriber's first payment.
 * - **Ids are per-resource integers.** Order 7 and invoice 7 are different
 *   objects, and `revenue_objects` is unique on `(site, provider, object_id)`
 *   with the kind outside the key — so an invoice's object id is prefixed
 *   (`invoice:7`) or the two would overwrite each other's head.
 * - **A refund is an amount, not an object.** Orders and invoices carry a
 *   cumulative `refunded_amount`, and no refund has an id or an API of its own.
 *   The rollup subtracts a refund only through a refund *object* (D2d: a
 *   refunded charge keeps its full gross), so each refunded charge produces a
 *   derived refund object `<charge id>:refund` holding the cumulative amount.
 *   A second partial refund updates it rather than adding a row.
 * - **There are no disputes** in Lemon Squeezy's events or API. The resource is
 *   walked as an empty page, like Polar's.
 * - **Webhooks carry no event id and no event time.** The envelope is `{meta,
 *   data}`. The ledger key is derived from the object's state (`eventIdentity`),
 *   and the ordering input is the object's `updated_at`.
 *
 * The two port rules hold unsoftened: nothing throws, and no response body
 * leaves the adapter. Amounts are integer passthrough from Lemon Squeezy's own
 * minor-unit fields.
 */

export const LEMONSQUEEZY_REVENUE_PROVIDER_ID = 'lemonsqueezy'
export const LEMONSQUEEZY_API_BASE = 'https://api.lemonsqueezy.com/v1'

/** The probe. Orders are what the sync path starts with; the body is not read. */
const PROBE_PATH = '/orders?page[size]=1'
/** A customer is waiting on a form submit. */
const PROBE_TIMEOUT_MS = 10_000
/** A request with no deadline inside a leased job is a lease that expires. */
const SYNC_TIMEOUT_MS = 30_000

/** Lemon Squeezy's documented list maximum. */
export const LEMONSQUEEZY_LIST_PAGE_SIZE = 100

/** The object-id prefix that keeps invoice heads apart from order heads. */
const INVOICE_ID_PREFIX = 'invoice:'
/** The suffix of a derived refund object's id. */
const REFUND_ID_SUFFIX = ':refund'

type ChargeSource = 'order' | 'invoice'

/**
 * The consumed event allowlist (D4).
 *
 * The four `subscription_payment_*` events and the two `order_*` ones are every
 * money-bearing type Lemon Squeezy documents. The subscription lifecycle, license
 * keys and customers are understood and carry no money object. Anything else is
 * ledgered `ignored` and acked.
 */
const CONSUMED_EVENTS: Readonly<Record<string, ChargeSource | null>> = {
  order_created: 'order',
  order_refunded: 'order',
  subscription_payment_success: 'invoice',
  subscription_payment_failed: 'invoice',
  subscription_payment_recovered: 'invoice',
  subscription_payment_refunded: 'invoice',
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

/** The JSON:API `type` each source's `data` must carry. */
const DATA_TYPES: Readonly<Record<ChargeSource, string>> = {
  order: 'orders',
  invoice: 'subscription-invoices',
}

// --- Shape readers -----------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** `Number.isSafeInteger`: a corrupted `1234.5` is refused, never rounded. */
const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

/**
 * An id Lemon Squeezy sends as an integer attribute, as a string.
 *
 * `null` is a real value here (an order with no affiliate, an invoice whose
 * customer was deleted) and reads as `''`. `String(null)` would store the word
 * "null" as a customer id, which then hashes and joins like a real one.
 */
function idString(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string') return value
  return ''
}

function isoToDate(value: unknown): Date | null {
  const raw = asString(value)
  if (raw === null) return null
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : new Date(at)
}

/** Lowercase ISO-4217, as D5 stores it. */
function currencyOf(attrs: Record<string, unknown>): string | null {
  const raw = asString(attrs['currency'])
  return raw === null || raw === '' ? null : raw.toLowerCase()
}

/**
 * The site's own opaque reference (D5/D6 signal 2).
 *
 * Checkout custom data reaches a webhook as `meta.custom_data`; a listed or
 * fetched object has no envelope and so carries none. Read with OA's documented
 * key first, then the two spellings a site following Lemon Squeezy's own guides
 * already sends.
 */
function siteReference(meta: Record<string, unknown> | null): string {
  const customData = asRecord(meta?.['custom_data'])
  if (!customData) return ''
  for (const key of ['oa_external_id', 'client_reference_id', 'user_id']) {
    const value = asString(customData[key])
    if (value !== null && value !== '') return value
  }
  return ''
}

/** Absent strings are `''`: the snapshot is hashed, and ClickHouse has no null. */
function snapshot(
  base: Pick<RevenueNormalizedObject, 'object_kind' | 'status' | 'livemode' | 'currency'>,
  gross: number,
  occurredAt: Date,
  refs: Partial<
    Pick<
      RevenueNormalizedObject,
      | 'parent_object_id'
      | 'order_id'
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
    // Unknown, never zero: Lemon Squeezy reports no fee on an order or invoice.
    fee_minor: 0,
    fee_currency: '',
    net_minor: gross,
    occurred_at: occurredAt.toISOString(),
    parent_object_id: refs.parent_object_id ?? '',
    order_id: refs.order_id ?? '',
    checkout_session_id: '',
    client_reference_id: refs.client_reference_id ?? '',
    subscription_id: refs.subscription_id ?? '',
    product_id: refs.product_id ?? '',
    product_name: refs.product_name ?? '',
    customer_id: refs.customer_id ?? '',
  }
}

/**
 * A charge's status in D5's vocabulary, or null when it is not a charge yet.
 *
 * - `paid` is `succeeded`, promoted by a non-zero `refunded_amount` — the
 *   documented invoice example shows a partial refund on a `paid` invoice.
 * - `partial_refund` is spelled `partially_refunded`, the other providers' word.
 * - `fraudulent` orders were blocked rather than charged: `failed`.
 * - `void` invoices were cancelled or unpayable: `canceled`.
 * - A `pending` **invoice** is a renewal awaiting payment, not money in flight,
 *   and the rollup would count it (`NO_MONEY_STATUSES` is a closed set). It is
 *   no charge — unless the event saying so is `subscription_payment_failed`,
 *   whose invoice stays `pending` while dunning retries, and which is a failure.
 */
function chargeStatus(
  source: ChargeSource,
  attrs: Record<string, unknown>,
  eventName: string | null,
): string | null {
  const status = (asString(attrs['status']) ?? '').toLowerCase()
  const refunded = asInteger(attrs['refunded_amount']) ?? 0
  const total = asInteger(attrs['total']) ?? 0

  if (status === 'refunded' || attrs['refunded'] === true) return 'refunded'
  if (status === 'partial_refund') return 'partially_refunded'
  if (status === 'paid') {
    if (refunded > 0) return refunded >= total && total > 0 ? 'refunded' : 'partially_refunded'
    return 'succeeded'
  }
  if (status === 'fraudulent') return 'failed'
  if (status === 'void') return 'canceled'
  if (status === 'pending' && source === 'invoice') {
    return eventName === 'subscription_payment_failed' ? 'failed' : null
  }
  return status === '' ? null : status
}

/** The initial invoice of a subscription: the same money as its order. */
function isDuplicateOfOrder(source: ChargeSource, attrs: Record<string, unknown>): boolean {
  return source === 'invoice' && asString(attrs['billing_reason']) === 'initial'
}

function chargeObjectId(source: ChargeSource, id: string): string {
  return source === 'invoice' ? `${INVOICE_ID_PREFIX}${id}` : id
}

type Normalized = { charge: RevenueObservation; refund: RevenueObservation | null } | 'not_money'

/**
 * An Order or a Subscription Invoice → a charge, plus its derived refund.
 *
 * ## The amount is `total - tax`
 *
 * `total` is what the customer paid after discounts, tax included; `tax` is the
 * part Lemon Squeezy remits as merchant of record. A zero total is zero revenue
 * whatever `tax` says, the rule the Dodo adapter learned from a real proration.
 *
 * ## The refund keeps the tax
 *
 * `refunded_amount` is the amount returned to the customer, and Lemon Squeezy
 * reports no tax portion of it — so, as for Dodo, a full refund reads larger
 * than the charge it reverses by that charge's tax. Pro-rating it would be a
 * derived, rounded amount on a path kept to integer passthrough.
 */
function normalizeCharge(
  source: ChargeSource,
  data: Record<string, unknown>,
  meta: Record<string, unknown> | null,
  eventName: string | null,
): Normalized | null {
  const id = asString(data['id'])
  const attrs = asRecord(data['attributes'])
  if (id === null || id === '' || !attrs) return null

  const currency = currencyOf(attrs)
  const total = asInteger(attrs['total'])
  const created = isoToDate(attrs['created_at'])
  if (currency === null || total === null || created === null) return null
  if (!('tax' in attrs)) return null
  const reportedTax = attrs['tax'] === null ? 0 : asInteger(attrs['tax'])
  if (reportedTax === null) return null
  const tax = total === 0 ? 0 : reportedTax
  if (tax < 0 || tax > total) return null

  if (isDuplicateOfOrder(source, attrs)) return 'not_money'
  const status = chargeStatus(source, attrs, eventName)
  if (status === null) return 'not_money'

  const livemode = !(attrs['test_mode'] === true || meta?.['test_mode'] === true)
  const objectId = chargeObjectId(source, id)
  const firstItem = source === 'order' ? asRecord(attrs['first_order_item']) : null
  const refs = {
    client_reference_id: siteReference(meta),
    customer_id: idString(attrs['customer_id']),
    subscription_id: idString(attrs['subscription_id']),
  }

  const charge: RevenueObservation = {
    objectId,
    objectKind: 'charge',
    snapshotAt: created,
    normalized: snapshot(
      { object_kind: 'charge', status, livemode, currency },
      total - tax,
      created,
      {
        ...refs,
        // The order is the order identity — the value a success page that knows
        // the order passes to `oa.conversion`. An invoice is its own order: a
        // renewal is not retried into several charges under one id.
        order_id: objectId,
        product_id: firstItem ? idString(firstItem['product_id']) : '',
        product_name: firstItem ? (asString(firstItem['product_name']) ?? '') : '',
      },
    ),
  }

  const refundedAmount = asInteger(attrs['refunded_amount']) ?? 0
  if (refundedAmount <= 0) return { charge, refund: null }

  // `refunded_at` is set only once the charge is fully refunded; a partial
  // refund's time is the last change to the charge, which is the refund.
  const refundedAt = isoToDate(attrs['refunded_at']) ?? isoToDate(attrs['updated_at']) ?? created
  const refund: RevenueObservation = {
    objectId: `${objectId}${REFUND_ID_SUFFIX}`,
    objectKind: 'refund',
    snapshotAt: refundedAt,
    normalized: snapshot(
      { object_kind: 'refund', status: 'succeeded', livemode, currency },
      refundedAmount,
      refundedAt,
      { ...refs, parent_object_id: objectId, order_id: objectId },
    ),
  }
  return { charge, refund }
}

/**
 * The ledger key for a delivery.
 *
 * Lemon Squeezy sends no event id, so one is derived from what the delivery
 * says: the event, the object, and the object's `updated_at`. A retry of the
 * same delivery restates the same state and so the same key — the dedupe the
 * ledger exists for — while a later change to the object moves `updated_at` and
 * is a new event. The signature header would also be stable across retries, but
 * it is a function of the signing secret, and a rotated secret would make one
 * delivery look like two.
 */
function eventIdentity(
  eventName: string,
  data: Record<string, unknown>,
  attrs: Record<string, unknown> | null,
): string | null {
  const type = asString(data['type'])
  const id = asString(data['id'])
  const stamp = asString(attrs?.['updated_at']) ?? asString(attrs?.['created_at'])
  if (!type || !id || !stamp) return null
  return `${eventName}:${type}:${id}:${stamp}`
}

// --- The cursor --------------------------------------------------------------

/**
 * The walk's position: which list, and which page of it.
 *
 * Charges come from two lists, orders then invoices, under one resource, so the
 * cursor names the list as well as the page. `orders|3`, `invoices|1`.
 *
 * Page numbers are safe to resume from here, which they were not for Polar:
 * Lemon Squeezy's lists take no date filter, so every walk reads the whole list
 * and filters in memory. A new order arriving mid-walk can only push rows *down*
 * a page — re-reading one row, which the ledger makes free — and never skip one.
 */
interface LemonSqueezyCursor {
  readonly list: ChargeSource
  readonly page: number
}

const LIST_PATHS: Readonly<Record<ChargeSource, string>> = {
  order: '/orders',
  invoice: '/subscription-invoices',
}

function encodeCursor(cursor: LemonSqueezyCursor): string {
  return `${cursor.list === 'order' ? 'orders' : 'invoices'}|${String(cursor.page)}`
}

function decodeCursor(raw: string): LemonSqueezyCursor | null {
  const [list, pageRaw, ...rest] = raw.split('|')
  if (rest.length > 0 || pageRaw === undefined) return null
  const page = Number(pageRaw)
  if (!Number.isSafeInteger(page) || page < 1) return null
  if (list === 'orders') return { list: 'order', page }
  if (list === 'invoices') return { list: 'invoice', page }
  return null
}

// --- HTTP helpers ------------------------------------------------------------

/** Bounded at five minutes: the runner's backoff is safer than an hour's sleep. */
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

/**
 * One authenticated GET, with every failure typed.
 *
 * The residual-4xx split is the other adapters': only the page number comes from
 * a stored value, so on a resumed list request a residual 4xx is
 * `invalid_cursor` (drop it and re-walk) and everywhere else `unauthorized`.
 * No `sort` parameter is sent: Lemon Squeezy does not document one, and a 400
 * on the first page of a walk would read as a rejected key.
 */
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
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/vnd.api+json' },
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

// --- The adapter -------------------------------------------------------------

export function createLemonSqueezyRevenueAdapter(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = LEMONSQUEEZY_API_BASE,
): RevenueAdapter {
  /** The current state of one charge, or of the charge a derived refund hangs off. */
  async function fetchCharge(
    apiKey: string,
    chargeId: string,
  ): Promise<LemonSqueezyGetFailure | { ok: true; normalized: Normalized | null }> {
    const source: ChargeSource = chargeId.startsWith(INVOICE_ID_PREFIX) ? 'invoice' : 'order'
    const id = source === 'invoice' ? chargeId.slice(INVOICE_ID_PREFIX.length) : chargeId
    const result = await lemonSqueezyGet(
      fetchImpl,
      baseUrl,
      apiKey,
      `${LIST_PATHS[source]}/${encodeURIComponent(id)}`,
    )
    if (!result.ok) return result
    const data = asRecord(result.body['data'])
    return { ok: true, normalized: data ? normalizeCharge(source, data, null, null) : null }
  }

  return {
    providerId: LEMONSQUEEZY_REVENUE_PROVIDER_ID,

    async verifyCredential(secretKey: string): Promise<RevenueCredentialVerification> {
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${PROBE_PATH}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${secretKey}`, accept: 'application/vnd.api+json' },
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
        // The request is built entirely here, so a residual 4xx means the key
        // did not buy the read.
        return {
          outcome: 'unauthorized',
          detail: `lemonsqueezy responded ${String(response.status)}`,
        }
      }
      return { outcome: 'ok' }
    },

    verifyWebhook(input): RevenueWebhookVerification {
      const verified = verifyLemonSqueezySignature({
        rawBody: input.rawBody,
        header: input.headers?.['x-signature'] ?? input.signatureHeader,
        secret: input.signingSecret,
      })
      return verified.ok ? { ok: true } : { ok: false, reason: verified.reason }
    },

    normalizeEvent(parsedEvent: unknown): RevenueNormalizeOutcome {
      const event = asRecord(parsedEvent)
      const meta = asRecord(event?.['meta'])
      const eventType = meta ? asString(meta['event_name']) : null
      const data = asRecord(event?.['data'])
      const attrs = asRecord(data?.['attributes'])
      // No event time exists: the object's last change is when this state became
      // true, and the only ordering input that moves with it. Never `new Date()`,
      // which would make a redelivery look newer than the state it repeats.
      const eventAt = isoToDate(attrs?.['updated_at']) ?? isoToDate(attrs?.['created_at'])
      const eventId = eventType && data ? eventIdentity(eventType, data, attrs) : null
      if (!event || !eventType || !data || !eventAt || !eventId) {
        return { ok: false, reason: 'malformed_event' }
      }

      const base = { eventId, eventType, eventAt }

      if (!(eventType in CONSUMED_EVENTS)) return ignored(base, 'unhandled_event_type')
      const source = CONSUMED_EVENTS[eventType]
      if (source === null || source === undefined) return ignored(base, 'no_observations')
      if (asString(data['type']) !== DATA_TYPES[source]) {
        return ignored(base, 'unsupported_object_shape')
      }

      const normalized = normalizeCharge(source, data, meta, eventType)
      if (normalized === 'not_money') return ignored(base, 'no_observations')
      if (normalized === null) return ignored(base, 'unsupported_object_shape')

      const observations = [normalized.charge, normalized.refund]
        .filter((observation): observation is RevenueObservation => observation !== null)
        // The event's time, not the object's `created_at`, which never moves.
        .map((observation) => ({ ...observation, snapshotAt: eventAt }))

      return { ok: true, event: { ...base, observations } }
    },

    /**
     * One page of a list.
     *
     * Charges walk orders, then subscription invoices, and each charge brings its
     * derived refund with it — a refund has no list of its own to walk. So the
     * `refunds` and `disputes` resources answer one empty final page.
     *
     * The window is applied here, per observation and on its own time: a refund
     * today on an order from last quarter is inside a reconcile window that the
     * order is not. Nothing is filtered server-side because nothing can be.
     */
    async listObjects(
      secretKey: string,
      resource: RevenueSyncResource,
      options: RevenueListOptions,
    ): Promise<RevenueListOutcome> {
      if (resource !== 'charges') {
        return { ok: true, page: { observations: [], nextCursor: null, hasMore: false } }
      }

      let cursor: LemonSqueezyCursor = { list: 'order', page: 1 }
      if (options.cursor !== null && options.cursor !== '') {
        const decoded = decodeCursor(options.cursor)
        if (decoded === null) {
          return {
            ok: false,
            reason: 'invalid_cursor',
            detail: 'lemonsqueezy cursor is unreadable',
          }
        }
        cursor = decoded
      }

      const limit = Math.min(Math.max(options.pageSize, 1), LEMONSQUEEZY_LIST_PAGE_SIZE)
      const query = new URLSearchParams({
        'page[number]': String(cursor.page),
        'page[size]': String(limit),
      })
      const result = await lemonSqueezyGet(
        fetchImpl,
        baseUrl,
        secretKey,
        `${LIST_PATHS[cursor.list]}?${query.toString()}`,
        { cursorSensitive: options.cursor !== null && options.cursor !== '' },
      )
      if (!result.ok) return failure(result)

      const items = result.body['data']
      if (!Array.isArray(items)) {
        // Treating this as an empty page would complete a list never read.
        return {
          ok: false,
          reason: 'unavailable',
          detail: 'lemonsqueezy list response has no data array',
        }
      }

      const from = options.windowStart.getTime()
      const to = options.windowEnd.getTime()
      const observations: RevenueObservation[] = []
      for (const row of items) {
        const data = asRecord(row)
        if (!data) continue
        const normalized = normalizeCharge(cursor.list, data, null, null)
        if (normalized === null || normalized === 'not_money') continue
        for (const observation of [normalized.charge, normalized.refund]) {
          if (observation === null) continue
          const at = observation.snapshotAt.getTime()
          if (at >= from && at <= to) observations.push(observation)
        }
      }

      const page = asRecord(asRecord(result.body['meta'])?.['page'])
      const lastPage = asInteger(page?.['lastPage'])
      const hasNext =
        asString(asRecord(result.body['links'])?.['next']) !== null ||
        (lastPage !== null && cursor.page < lastPage)

      let next: LemonSqueezyCursor | null = null
      if (hasNext) next = { list: cursor.list, page: cursor.page + 1 }
      else if (cursor.list === 'order') next = { list: 'invoice', page: 1 }

      return {
        ok: true,
        page: {
          observations,
          nextCursor: next === null ? null : encodeCursor(next),
          hasMore: next !== null,
        },
      }
    },

    async fetchObject(
      secretKey: string,
      objectKind: RevenueObjectKind,
      objectId: string,
    ): Promise<RevenueFetchOutcome> {
      if (objectKind === 'dispute') return { ok: true, observation: null, missing: true }

      const chargeId =
        objectKind === 'refund' && objectId.endsWith(REFUND_ID_SUFFIX)
          ? objectId.slice(0, -REFUND_ID_SUFFIX.length)
          : objectId
      const result = await fetchCharge(secretKey, chargeId)
      if (!result.ok) {
        if (result.missing === true) return { ok: true, observation: null, missing: true }
        return failure(result)
      }
      if (result.normalized === null) {
        return { ok: false, reason: 'unavailable', detail: 'lemonsqueezy object could not be read' }
      }
      if (result.normalized === 'not_money') return { ok: true, observation: null, missing: true }

      const observation =
        objectKind === 'refund' ? result.normalized.refund : result.normalized.charge
      return observation === null
        ? { ok: true, observation: null, missing: true }
        : { ok: true, observation }
    },
  }
}

function ignored(
  base: { eventId: string; eventType: string; eventAt: Date },
  reason: RevenueIgnoreReason,
): RevenueNormalizeOutcome {
  return { ok: true, event: { ...base, observations: [], ignored: reason } }
}

/** A typed GET failure, narrowed to the adapter's public failure shape. */
function failure(result: LemonSqueezyGetFailure): RevenueListOutcome & RevenueFetchOutcome {
  return {
    ok: false,
    reason: result.reason,
    detail: result.detail,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  }
}

export { revenueObservationHash }
