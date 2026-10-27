import {
  revenueObservationHash,
  type RevenueAdapter,
  type RevenueCredentialVerification,
  type RevenueFetchOutcome,
  type RevenueIgnoreReason,
  type RevenueListOptions,
  type RevenueListOutcome,
  type RevenueMatchHint,
  type RevenueNormalizeOutcome,
  type RevenueNormalizedObject,
  type RevenueObjectKind,
  type RevenueObservation,
  type RevenueSyncResource,
  type RevenueWebhookVerification,
} from '@openanalytics/domain'
import { verifyHexHmacSignature } from './hex-hmac-signature.ts'

/**
 * The Creem revenue adapter (ADR-0033, D1/D4; the D9 follow-up row for Creem).
 *
 * The fifth provider: an adapter and a catalog flip. No migration, no
 * environment variable, no OpenAPI change, no new grant. SDK-free like the
 * adapters beside it.
 *
 * ## The money object is the transaction
 *
 * Creem reports one payment through several envelopes — a checkout's order, a
 * subscription's `last_transaction`, a refund's or a dispute's `transaction` —
 * and every one of them names the same `tran_…`. So the charge head is keyed on
 * the transaction id, and a new subscriber's first payment, which arrives as
 * both `checkout.completed` and `subscription.paid`, lands on one head instead
 * of two. The order (`ord_…`) is the charge's `order_id`.
 *
 * ## The checkout id travels as a hint
 *
 * Only `checkout.completed` knows the checkout (`ch_…`) and its metadata — the
 * values a site's success page has, and so the strongest match it can send. The
 * `subscription.paid` for the same payment does not, and if it is the later of
 * the two its snapshot would replace one that carried them. So the checkout also
 * becomes a match hint (D6) keyed on the order, which the projection reads for
 * exactly that case: a charge whose own snapshot has no checkout id.
 *
 * ## Refunds are derived from the transaction
 *
 * A refund has an id (`ref_…`) on its webhook, but there is no API to list or
 * fetch refunds — the only place a backfill can see one is the transaction's
 * cumulative `refunded_amount`. Keying the webhook's refund on `ref_…` and the
 * backfill's on the transaction would count one refund twice, so both paths
 * produce `<transaction>:refund`, cumulative, as for Lemon Squeezy.
 *
 * A charged-back transaction also reports its whole amount as `refunded_amount`.
 * That money belongs to the dispute, and deriving a refund from it as well would
 * subtract it twice, so a refund is derived only from `refunded` and
 * `partialRefund`.
 *
 * ## Disputes come from the webhook alone
 *
 * `dispute.created` carries a dispute with an id of its own and is the only
 * dispute event Creem documents; there is no dispute API. So a dispute is opened
 * from its webhook and is never listed, and the refetch path answers it as
 * missing — which settles a tie as a skip rather than a retry that cannot work.
 *
 * The port's rules hold: nothing throws, no response body leaves the adapter,
 * amounts are integer passthrough from Creem's own minor-unit fields.
 */

export const CREEM_REVENUE_PROVIDER_ID = 'creem'

/** Live. Sandbox is `https://test-api.creem.io`, a constructor argument for tests. */
export const CREEM_API_BASE = 'https://api.creem.io'
export const CREEM_TEST_API_BASE = 'https://test-api.creem.io'

/** The probe. Transactions are what the sync walks; the body is not read. */
const PROBE_PATH = '/v1/transactions/search?page_size=1'
/** A customer is waiting on a form submit. */
const PROBE_TIMEOUT_MS = 10_000
/** A request with no deadline inside a leased job is a lease that expires. */
const SYNC_TIMEOUT_MS = 30_000

/**
 * The page size. Creem documents no maximum, so this stays at the size the other
 * providers cap at rather than trusting a larger one to be honoured.
 */
export const CREEM_LIST_PAGE_SIZE = 100

const REFUND_ID_SUFFIX = ':refund'

/**
 * The consumed event allowlist (D4).
 *
 * The money events are the checkout, a subscription payment, a refund and a
 * dispute. The rest of the subscription lifecycle and the credits family are
 * understood and carry no money object. Anything else is ledgered `ignored` and
 * acked.
 */
type CreemSource = 'checkout' | 'subscription' | 'refund' | 'dispute'

const CONSUMED_EVENTS: Readonly<Record<string, CreemSource | null>> = {
  'checkout.completed': 'checkout',
  'subscription.paid': 'subscription',
  'refund.created': 'refund',
  'dispute.created': 'dispute',
  'subscription.active': null,
  'subscription.trialing': null,
  'subscription.update': null,
  'subscription.canceled': null,
  'subscription.scheduled_cancel': null,
  'subscription.past_due': null,
  'subscription.unpaid': null,
  'subscription.paused': null,
  'subscription.expired': null,
}

/** The `object` field each source's payload must declare. */
const OBJECT_TYPES: Readonly<Record<CreemSource, string>> = {
  checkout: 'checkout',
  subscription: 'subscription',
  refund: 'refund',
  dispute: 'dispute',
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
 * A Creem timestamp → Date. Creem uses both forms: an envelope's and a
 * transaction's `created_at` are epoch **milliseconds**, an order's or a
 * customer's are ISO-8601 strings.
 */
function toDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return new Date(value)
  const raw = asString(value)
  if (raw === null) return null
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : new Date(at)
}

/** Lowercase ISO-4217, as D5 stores it. Creem sends uppercase. */
function currencyOf(value: unknown): string | null {
  const raw = asString(value)
  return raw === null || raw === '' ? null : raw.toLowerCase()
}

/** A reference that is an id string or an expanded object with an `id`. */
function refId(value: unknown): string {
  const direct = asString(value)
  if (direct !== null) return direct
  return asString(asRecord(value)?.['id']) ?? ''
}

/**
 * The site's own opaque reference (D5/D6 signal 2).
 *
 * The customer's `external_id` — Creem's field for "the id this merchant knows
 * this customer by" — first, then checkout metadata under OA's documented key
 * and the spellings a site following Creem's own guides already sends. Creem
 * copies checkout metadata onto the subscription, so a renewal finds it there.
 */
function siteReference(...sources: (Record<string, unknown> | null)[]): string {
  for (const source of sources) {
    if (!source) continue
    const external = asString(asRecord(source['customer'])?.['external_id'])
    if (external !== null && external !== '') return external
    const metadata = asRecord(source['metadata'])
    if (!metadata) continue
    for (const key of ['oa_external_id', 'userId', 'user_id', 'client_reference_id']) {
      const value = asString(metadata[key])
      if (value !== null && value !== '') return value
    }
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
    // Unknown, never zero: Creem reports no fee on a transaction.
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

/**
 * A transaction status in D5's vocabulary.
 *
 * Creem's camelCase states take the other providers' spellings. `chargedBack`
 * stays counted — the dispute object carries the withdrawal, as Stripe's does —
 * and `declined`/`uncollectible` moved no money, so they are `failed`.
 */
function transactionStatus(raw: unknown): string {
  const status = asString(raw) ?? ''
  switch (status) {
    case 'paid':
      return 'succeeded'
    case 'refunded':
      return 'refunded'
    case 'partialRefund':
      return 'partially_refunded'
    case 'chargedBack':
      return 'charged_back'
    case 'declined':
    case 'uncollectible':
      return 'failed'
    case 'canceled':
    case 'void':
      return 'canceled'
    case '':
      return 'pending'
    default:
      return status.toLowerCase()
  }
}

/** The refund-bearing statuses; see the module header on charge-backs. */
const REFUNDED_STATUSES: ReadonlySet<string> = new Set(['refunded', 'partialRefund'])

interface ChargeContext {
  readonly livemode: boolean
  readonly checkoutId?: string
  readonly clientReference?: string
  readonly customerId?: string
  readonly productId?: string
  readonly productName?: string
  /** A checkout's order names no subscription; the checkout itself does. */
  readonly subscriptionId?: string
}

/**
 * A transaction → its charge, plus the refund derived from it.
 *
 * ## The amount is `amount_paid - tax_amount`
 *
 * `amount_paid` is what the customer paid, tax included; `tax_amount` is the part
 * Creem remits as merchant of record. A zero payment is zero revenue whatever
 * the tax says. The refund keeps the tax, as for Dodo and Lemon Squeezy: Creem
 * reports no tax portion of `refunded_amount`.
 *
 * `transaction` is either a full transaction or — on a checkout's order — the
 * order itself, whose `transaction` field names the id and whose amounts have
 * the same names.
 */
function normalizeTransaction(
  transaction: Record<string, unknown>,
  context: ChargeContext,
): { charge: RevenueObservation; refund: RevenueObservation | null } | null {
  const isOrder = asString(transaction['object']) === 'order'
  const id = isOrder ? asString(transaction['transaction']) : asString(transaction['id'])
  const currency = currencyOf(transaction['currency'])
  const paid = asInteger(transaction['amount_paid'])
  const created = toDate(transaction['created_at'])
  if (id === null || id === '' || currency === null || paid === null || created === null) {
    return null
  }
  const reportedTax = transaction['tax_amount'] == null ? 0 : asInteger(transaction['tax_amount'])
  if (reportedTax === null) return null
  const tax = paid === 0 ? 0 : reportedTax
  if (tax < 0 || tax > paid) return null

  const orderId = isOrder ? (asString(transaction['id']) ?? '') : refId(transaction['order'])
  const refs = {
    order_id: orderId,
    client_reference_id: context.clientReference ?? '',
    customer_id: context.customerId || refId(transaction['customer']),
    subscription_id: context.subscriptionId || refId(transaction['subscription']),
  }

  const charge: RevenueObservation = {
    objectId: id,
    objectKind: 'charge',
    snapshotAt: created,
    normalized: snapshot(
      {
        object_kind: 'charge',
        status: transactionStatus(transaction['status']),
        livemode: context.livemode,
        currency,
      },
      paid - tax,
      created,
      {
        ...refs,
        checkout_session_id: context.checkoutId ?? '',
        product_id: context.productId || refId(transaction['product']),
        product_name: context.productName ?? '',
      },
    ),
  }

  const refunded = asInteger(transaction['refunded_amount']) ?? 0
  const status = asString(transaction['status']) ?? ''
  if (refunded <= 0 || !REFUNDED_STATUSES.has(status)) return { charge, refund: null }

  return {
    charge,
    refund: {
      objectId: `${id}${REFUND_ID_SUFFIX}`,
      objectKind: 'refund',
      // A listed transaction carries no refund time; the webhook path overrides
      // this with the refund event's own. See the module header.
      snapshotAt: created,
      normalized: snapshot(
        { object_kind: 'refund', status: 'succeeded', livemode: context.livemode, currency },
        refunded,
        created,
        { ...refs, parent_object_id: id },
      ),
    },
  }
}

/** A dispute → a dispute observation. Creem sends no dispute status: it is open. */
function normalizeDispute(
  dispute: Record<string, unknown>,
  livemode: boolean,
): RevenueObservation | null {
  const id = asString(dispute['id'])
  const currency = currencyOf(dispute['currency'])
  const amount = asInteger(dispute['amount'])
  const created = toDate(dispute['created_at'])
  if (id === null || id === '' || currency === null || amount === null || created === null) {
    return null
  }
  const transaction = asRecord(dispute['transaction'])
  const transactionId = refId(dispute['transaction'])
  return {
    objectId: id,
    objectKind: 'dispute',
    snapshotAt: created,
    normalized: snapshot(
      { object_kind: 'dispute', status: 'opened', livemode, currency },
      amount,
      created,
      {
        parent_object_id: transactionId,
        order_id: transaction ? refId(transaction['order']) : refId(dispute['order']),
        customer_id: refId(dispute['customer']),
        subscription_id: transaction ? refId(transaction['subscription']) : '',
      },
    ),
  }
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

interface CreemGetSuccess {
  readonly ok: true
  readonly body: Record<string, unknown>
}

interface CreemGetFailure {
  readonly ok: false
  readonly reason: 'unavailable' | 'unauthorized' | 'invalid_cursor'
  readonly detail: string
  readonly retryAfterMs?: number
  readonly missing?: boolean
}

/**
 * One authenticated GET, with every failure typed. The residual-4xx split is the
 * other adapters': only the page number comes from a stored value.
 */
async function creemGet(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  path: string,
  options: { readonly cursorSensitive?: boolean } = {},
): Promise<CreemGetSuccess | CreemGetFailure> {
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'creem request did not complete' }
  }

  if (response.status === 429) {
    const after = retryAfterMs(response)
    return {
      ok: false,
      reason: 'unavailable',
      detail: 'creem responded 429',
      ...(after === undefined ? {} : { retryAfterMs: after }),
    }
  }
  if (response.status >= 500) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: `creem responded ${String(response.status)}`,
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'unauthorized',
      detail: `creem responded ${String(response.status)}`,
    }
  }

  const residual: CreemGetFailure['reason'] =
    options.cursorSensitive === true ? 'invalid_cursor' : 'unauthorized'

  if (response.status === 404) {
    return { ok: false, reason: residual, detail: 'creem responded 404', missing: true }
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || asRecord(body) === null) {
    return { ok: false, reason: residual, detail: `creem responded ${String(response.status)}` }
  }
  return { ok: true, body: body as Record<string, unknown> }
}

// --- The adapter -------------------------------------------------------------

export function createCreemRevenueAdapter(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = CREEM_API_BASE,
): RevenueAdapter {
  // Test and live are separate hosts with separate keys: the environment is the
  // base URL. The payloads' `mode` is not used — its documented values include a
  // `local` that says nothing about whether money moved.
  const livemode = baseUrl === CREEM_API_BASE

  /**
   * One delivery's object → observations and hints.
   *
   * Every observation is re-timed to the event: an object's own `created_at`
   * never moves, so two states of one transaction would otherwise share it.
   */
  function normalizeObject(
    source: CreemSource,
    object: Record<string, unknown>,
    eventAt: Date,
  ): { observations: RevenueObservation[]; hints: RevenueMatchHint[] } | null {
    if (source === 'dispute') {
      const dispute = normalizeDispute(object, livemode)
      return dispute ? { observations: [dispute], hints: [] } : null
    }

    let transaction: Record<string, unknown> | null
    let context: ChargeContext
    let hint: RevenueMatchHint | null = null

    if (source === 'checkout') {
      transaction = asRecord(object['order'])
      const checkoutId = asString(object['id']) ?? ''
      const product = asRecord(object['product'])
      const clientReference = siteReference(object)
      const customerId = refId(object['customer'])
      context = {
        livemode,
        checkoutId,
        clientReference,
        customerId,
        productId: refId(object['product']),
        productName: product ? (asString(product['name']) ?? '') : '',
        subscriptionId: refId(object['subscription']),
      }
      const orderId = transaction ? (asString(transaction['id']) ?? '') : ''
      if (checkoutId !== '') {
        hint = {
          checkoutSessionId: checkoutId,
          orderId,
          clientReferenceId: clientReference,
          customerId,
          occurredAt: eventAt,
        }
      }
    } else if (source === 'subscription') {
      transaction = asRecord(object['last_transaction'])
      const product = asRecord(object['product'])
      context = {
        livemode,
        clientReference: siteReference(object),
        // The transaction's own `customer` is null on this event, by Creem's
        // documentation; the subscription's is the one to read.
        customerId: refId(object['customer']),
        productId: refId(object['product']),
        productName: product ? (asString(product['name']) ?? '') : '',
      }
    } else {
      transaction = asRecord(object['transaction'])
      context = {
        livemode,
        clientReference: siteReference(
          asRecord(object['checkout']),
          asRecord(object['subscription']),
        ),
        customerId: refId(object['customer']),
      }
    }

    if (!transaction) return null
    const normalized = normalizeTransaction(transaction, context)
    if (!normalized) return null

    const observations = [normalized.charge, normalized.refund]
      .filter((observation): observation is RevenueObservation => observation !== null)
      .map((observation) => {
        if (observation.objectKind !== 'refund') return { ...observation, snapshotAt: eventAt }
        // The refund lands in the bucket of its own day, not the payment's.
        const refundedAt = toDate(object['created_at']) ?? eventAt
        return {
          ...observation,
          snapshotAt: eventAt,
          normalized: { ...observation.normalized, occurred_at: refundedAt.toISOString() },
        }
      })
    return { observations, hints: hint ? [hint] : [] }
  }

  async function fetchTransaction(
    apiKey: string,
    transactionId: string,
  ): Promise<CreemGetFailure | { ok: true; transaction: Record<string, unknown> }> {
    const query = new URLSearchParams({ transaction_id: transactionId })
    const result = await creemGet(
      fetchImpl,
      baseUrl,
      apiKey,
      `/v1/transactions?${query.toString()}`,
    )
    if (!result.ok) return result
    return { ok: true, transaction: result.body }
  }

  return {
    providerId: CREEM_REVENUE_PROVIDER_ID,

    async verifyCredential(secretKey: string): Promise<RevenueCredentialVerification> {
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${PROBE_PATH}`, {
          method: 'GET',
          headers: { 'x-api-key': secretKey, accept: 'application/json' },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      } catch {
        return { outcome: 'unavailable', detail: 'creem probe did not complete' }
      }
      if (response.status === 429 || response.status >= 500) {
        return { outcome: 'unavailable', detail: `creem responded ${String(response.status)}` }
      }
      if (!response.ok) {
        // A test-mode key sent to live is the mistake this will see most.
        return { outcome: 'unauthorized', detail: `creem responded ${String(response.status)}` }
      }
      return { outcome: 'ok' }
    },

    verifyWebhook(input): RevenueWebhookVerification {
      const verified = verifyHexHmacSignature({
        rawBody: input.rawBody,
        header: input.headers?.['creem-signature'] ?? input.signatureHeader,
        secret: input.signingSecret,
      })
      return verified.ok ? { ok: true } : { ok: false, reason: verified.reason }
    },

    /**
     * A Creem event → observations and hints. The id is the envelope's own
     * `evt_…`, which Creem keeps across automatic retries — the dedupe the
     * ledger needs. A manual resend from the dashboard gets a new id, which
     * costs a ledger row and nothing else: the object head skips a state it
     * already holds.
     */
    normalizeEvent(parsedEvent: unknown): RevenueNormalizeOutcome {
      const event = asRecord(parsedEvent)
      const eventId = event ? asString(event['id']) : null
      const eventType = event ? asString(event['eventType']) : null
      const eventAt = event ? toDate(event['created_at']) : null
      if (!event || !eventId || !eventType || !eventAt) {
        return { ok: false, reason: 'malformed_event' }
      }

      const base = { eventId, eventType, eventAt }

      if (!(eventType in CONSUMED_EVENTS)) return ignored(base, 'unhandled_event_type')
      const source = CONSUMED_EVENTS[eventType]
      if (source === null || source === undefined) return ignored(base, 'no_observations')

      const object = asRecord(event['object'])
      if (!object || asString(object['object']) !== OBJECT_TYPES[source]) {
        return ignored(base, 'unsupported_object_shape')
      }

      const normalized = normalizeObject(source, object, eventAt)
      if (!normalized) return ignored(base, 'unsupported_object_shape')
      if (normalized.observations.length === 0 && normalized.hints.length === 0) {
        return ignored(base, 'no_observations')
      }
      return {
        ok: true,
        event: {
          ...base,
          observations: normalized.observations,
          ...(normalized.hints.length > 0 ? { hints: normalized.hints } : {}),
        },
      }
    },

    /**
     * One page of transactions.
     *
     * Creem's search takes no date filter, so the walk reads every page and
     * applies the window per observation — a refund today on last quarter's
     * payment is inside a window its payment is not. A new transaction arriving
     * mid-walk can only push rows down a page, which re-reads one and skips none.
     * Each transaction brings its derived refund; refunds and disputes have no
     * list to walk, so those resources answer one empty final page.
     */
    async listObjects(
      secretKey: string,
      resource: RevenueSyncResource,
      options: RevenueListOptions,
    ): Promise<RevenueListOutcome> {
      if (resource !== 'charges') {
        return { ok: true, page: { observations: [], nextCursor: null, hasMore: false } }
      }

      let page = 1
      if (options.cursor !== null && options.cursor !== '') {
        const parsed = Number(options.cursor)
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return { ok: false, reason: 'invalid_cursor', detail: 'creem cursor is unreadable' }
        }
        page = parsed
      }

      const limit = Math.min(Math.max(options.pageSize, 1), CREEM_LIST_PAGE_SIZE)
      const query = new URLSearchParams({ page_number: String(page), page_size: String(limit) })
      const result = await creemGet(
        fetchImpl,
        baseUrl,
        secretKey,
        `/v1/transactions/search?${query.toString()}`,
        { cursorSensitive: options.cursor !== null && options.cursor !== '' },
      )
      if (!result.ok) return failure(result)

      const items = result.body['items']
      if (!Array.isArray(items)) {
        return { ok: false, reason: 'unavailable', detail: 'creem list response has no items' }
      }

      const from = options.windowStart.getTime()
      const to = options.windowEnd.getTime()
      const observations: RevenueObservation[] = []
      for (const row of items) {
        const transaction = asRecord(row)
        if (!transaction) continue
        const normalized = normalizeTransaction(transaction, { livemode })
        if (!normalized) continue
        for (const observation of [normalized.charge, normalized.refund]) {
          if (observation === null) continue
          const at = observation.snapshotAt.getTime()
          if (at >= from && at <= to) observations.push(observation)
        }
      }

      const next = asInteger(asRecord(result.body['pagination'])?.['next_page'])
      const hasMore = next !== null && next > page
      return {
        ok: true,
        page: { observations, nextCursor: hasMore ? String(next) : null, hasMore },
      }
    },

    async fetchObject(
      secretKey: string,
      objectKind: RevenueObjectKind,
      objectId: string,
    ): Promise<RevenueFetchOutcome> {
      if (objectKind === 'dispute') return { ok: true, observation: null, missing: true }

      const transactionId =
        objectKind === 'refund' && objectId.endsWith(REFUND_ID_SUFFIX)
          ? objectId.slice(0, -REFUND_ID_SUFFIX.length)
          : objectId
      const result = await fetchTransaction(secretKey, transactionId)
      if (!result.ok) {
        if (result.missing === true) return { ok: true, observation: null, missing: true }
        return failure(result)
      }
      const normalized = normalizeTransaction(result.transaction, { livemode })
      if (!normalized) {
        return { ok: false, reason: 'unavailable', detail: 'creem object could not be read' }
      }
      const observation = objectKind === 'refund' ? normalized.refund : normalized.charge
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
function failure(result: CreemGetFailure): RevenueListOutcome & RevenueFetchOutcome {
  return {
    ok: false,
    reason: result.reason,
    detail: result.detail,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  }
}

export { revenueObservationHash }
