import { createHash } from 'node:crypto'
import {
  ApiError,
  EVENT_SCHEMA_VERSION,
  eventBatchSchema,
  type ClientEvent,
  type EventBatch,
  type PersistedEvent,
} from '@openanalytics/contracts'
import {
  aiUtmSourceOf,
  attributionFrom,
  billableCount,
  classifyEvents,
  clickIdSourceOf,
  clientSessionHash,
  deriveVisitorContext,
  externalUserIdHash,
  refSourceOf,
  resolveEventTime,
  resolveReferrer,
  sanitizeInteraction,
  sanitizeProperties,
  sanitizeUrl,
  stripLinkingHints,
  type ClassificationCandidate,
  type SiteIngestConfig,
} from '@openanalytics/domain'
import type { EnqueueInput } from '@openanalytics/redis'
import { Hono } from 'hono'
import { readIngestBody } from './body.ts'
import { readRawClientAddress } from './client-identity.ts'
import type { CollectorDeps } from './deps.ts'
import { BotRequest, GpcOptOut, passIngestGate } from './ingest-gate.ts'
import type { IngestLimiter } from './limiter.ts'
import { COLLECTOR_METRICS } from './metrics.ts'
import { lastPageViewOf, presencePageFrom } from './presence.ts'

/**
 * `POST /v1/events` — the historical batch (docs snapshot 02 §7.1, §7.3).
 *
 * The rule this route exists to keep is one sentence long: **202 only after the
 * durable queue write succeeded.** Legacy swallowed store errors and answered
 * 200 for events it had not stored (docs snapshot 01 §4.3), and every structural
 * choice below is a way of making that impossible here rather than merely
 * avoided:
 *
 * - The queue call is the last thing that happens before the response. Nothing
 *   after it can turn a failure into a success.
 * - A queue failure is a `503` with `Retry-After`, and it is thrown, so there is
 *   no path that falls through to the 202.
 * - Everything with its own failure mode — the realtime update, the usage
 *   counter — happens *after* the queue write and cannot fail the request
 *   (§7.2). A realtime outage must not lose an accepted historical event.
 *
 * And the batch is atomic: validation runs over the whole batch first, and the
 * enqueue is one script, so an invalid event or an idempotency conflict leaves
 * nothing enqueued (§7.3).
 */

function parseBatch(json: unknown): EventBatch {
  const parsed = eventBatchSchema.safeParse(json)
  if (parsed.success) return parsed.data

  const first = parsed.error.issues[0]
  throw new ApiError('VALIDATION_FAILED', 'The event batch is not valid.', {
    details: {
      reason: 'schema',
      // The path, never the value: a validation message that echoed the payload
      // would put visitor data in an error body and in every log that keeps one.
      path: first?.path.join('.') ?? '',
      issue: first?.message ?? 'invalid',
    },
  })
}

/**
 * A stable hash of the event as the client sent it (D-209 step 1).
 *
 * Over the *client's* event rather than the server envelope, because the
 * envelope carries `accepted_at`, which differs on every retry — hashing it
 * would make each retry a different payload for the same id and turn every
 * honest retry into an idempotency conflict.
 */
function payloadHashOf(event: ClientEvent): string {
  return createHash('sha256').update(stableStringify(event)).digest('hex')
}

/** Key-ordered JSON, so two encodings of one event hash the same. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)

  return `{${entries.join(',')}}`
}

export function createEventRoutes(deps: CollectorDeps, limiter: IngestLimiter) {
  const routes = new Hono()

  routes.post('/', async (c) => {
    const receivedAt = deps.now?.() ?? new Date()
    const body = await readIngestBody(c)
    const batch = parseBatch(body.json)

    let gate
    try {
      gate = await passIngestGate(c, deps, (input) => limiter.check(input), {
        trackingKey: batch.tracking_key,
        cost: batch.events.length,
        receivedAt,
        endpoint: 'events',
      })
    } catch (error) {
      if (error instanceof BotRequest || error instanceof GpcOptOut) {
        // Bot traffic is not billed and does not enter analytics (G-005); it is
        // visible only in the aggregate security counter the gate already
        // incremented. The answer is the ordinary success shape rather than an
        // error, because telling a crawler it was identified only teaches it
        // what to change. A `Sec-GPC` drop (ADR-0057 D5) answers identically:
        // the visitor's opt-out is honoured, not announced.
        return c.json({ accepted: 0, duplicate: 0 }, 202)
      }
      throw error
    }

    const { config, settings, acceptedAt } = gate

    // Every event's time is decided before anything is written. §7.3: one
    // invalid event rejects the request, and "invalid" includes an event past
    // the 24-hour horizon (§7.2), so a partial enqueue is not reachable.
    const times = batch.events.map((event) => ({
      event,
      time: resolveEventTime({ occurredAt: event.occurred_at, acceptedAt }),
    }))

    const rejected = times.findIndex((entry) => !entry.time.accepted)
    if (rejected !== -1) {
      const entry = times[rejected]
      throw new ApiError('VALIDATION_FAILED', 'The batch contains an event the server refuses.', {
        details: {
          reason: entry?.time.accepted === false ? entry.time.reason : 'invalid_timestamp',
          index: rejected,
        },
      })
    }

    // ADR-0034, D5: `no_code_rule` origin is *established* from the site's own
    // published rule set, never believed from the wire. Three conditions, all
    // checked against the config this request already resolved -- so this costs
    // no extra read on the ingest path:
    //
    //   1. the event is a `custom_event`,
    //   2. its `rule_id` names a rule the site currently publishes,
    //   3. its `name` equals that rule's configured event name.
    //
    // A failure is deliberately NOT an error. A rule published seconds ago
    // against a 30-second-stale ingest-config cache (ADR-0022) would otherwise
    // reject the batch, and a batch is validated atomically -- one mis-timed
    // rule edit would take that visitor's pageviews with it. So an unresolvable
    // claim is ordinary `client_sdk` traffic, billed normally, which is also the
    // direction that cannot be exploited: claiming the origin can only ever cost
    // the claimant, never discount them.
    const publishedRuleNames = new Map<string, string>()
    for (const rule of gate.noCodeRules) publishedRuleNames.set(rule.rule_id, rule.name)

    const publishedRuleVersions = new Map<string, number>()
    for (const rule of gate.noCodeRules) publishedRuleVersions.set(rule.rule_id, rule.version)

    /** The published rule this event is established as coming from, or null. */
    const ruleFor = (event: ClientEvent): { ruleId: string; version: number } | null => {
      if (event.type !== 'custom_event') return null
      const ruleId = event.rule_id
      if (ruleId === undefined) return null
      if (publishedRuleNames.get(ruleId) !== event.name) return null
      return { ruleId, version: publishedRuleVersions.get(ruleId) ?? 1 }
    }

    const originFor = (event: ClientEvent): 'client_sdk' | 'no_code_rule' =>
      ruleFor(event) === null ? 'client_sdk' : 'no_code_rule'

    const candidates: ClassificationCandidate[] = batch.events.map((event) => ({
      eventId: event.event_id,
      type: event.type,
      origin: originFor(event),
      bot: false,
      ...('name' in event && event.name !== undefined ? { name: event.name } : {}),
      ...(event.action_id === undefined ? {} : { actionId: event.action_id }),
    }))
    const classifications = classifyEvents(candidates)
    const billable = billableCount(classifications)

    /**
     * The plan's window limit (D-103), when this build has plans.
     *
     * The whole gate — the near-realtime counter read, the ceiling, the buffer
     * and the rapid-burn signal — belongs to the surface that sells the plan, so
     * it is one call into the registered extension rather than four blocks here.
     * It throws `QUOTA_EXCEEDED` itself; what it returns is the window this batch
     * bills into, which the increment after the enqueue needs.
     *
     * Without an extension there is no window and no limit, and that is not a
     * gate failing open: an install with no plans has nothing to exceed.
     */
    const window =
      deps.cloud && gate.cloud
        ? await deps.cloud.checkUsage({
            config,
            facts: gate.cloud,
            acceptedAt,
            billable,
          })
        : null

    // Read once. `readRawClientAddress` is the single place the trusted-header
    // order lives; a second copy here would be two answers to "who is this".
    const rawAddress = readRawClientAddress(c)

    // The envelopes, kept as objects rather than only as the JSON that goes on
    // the queue: the realtime feed below needs one of them. It used to resolve
    // the referrer a second time from the raw event, which was correct until an
    // ingest inference existed and silently wrong afterwards -- a visitor whose
    // source came from a click id (ADR-0075) or a `?ref=` tag (ADR-0077) showed
    // as Direct on the live feed while the report the feed is the leading edge
    // of named the source. One derivation, read twice.
    const envelopes: PersistedEvent[] = []
    const enqueueInputs: EnqueueInput[] = batch.events.map((event, index) => {
      const time = times[index]?.time
      if (time === undefined || !time.accepted) {
        throw new ApiError('INTERNAL_ERROR', 'Event time missing after validation.', {
          expose: false,
        })
      }

      const persisted = buildPersistedEvent({
        event,
        batch,
        gateConfig: config,
        redactQueryKeys: settings.redactQueryKeys,
        attributedRevenue: settings.attributedRevenue,
        occurredAt: time.occurredAt,
        clockSkewed: time.clockSkewed,
        receivedAt: gate.receivedAt,
        acceptedAt,
        billable: classifications[index]?.billable ?? false,
        rule: ruleFor(event),
        usageWindowStart: window?.startsAt ?? acceptedAt,
        grace: gate.grace,
        deps,
        userAgent: gate.userAgent,
        country: gate.client.country,
        city: gate.client.city,
        rawAddress,
      })
      envelopes[index] = persisted

      return {
        siteId: config.siteId,
        eventId: event.event_id,
        payloadHash: payloadHashOf(event),
        payload: JSON.stringify(persisted),
        acceptedAt: acceptedAt.toISOString(),
      }
    })

    // The durable write. Everything before this is a decision; everything after
    // it is best-effort. A failure here is a 503 and never a 202 — the whole
    // point of the route (docs snapshot 01 §4.3, 02 §7.2).
    let result
    try {
      result = await deps.queue.enqueueBatch(enqueueInputs)
    } catch (error) {
      deps.metrics.increment(COLLECTOR_METRICS.queueWriteFailed, { site_id: config.siteId })
      c.header('Retry-After', String(deps.policy.QUEUE_FAILURE_RETRY_AFTER_SECONDS))
      throw new ApiError('SERVICE_UNAVAILABLE', 'The event could not be durably queued.', {
        details: { reason: 'queue_unavailable' },
        cause: error,
      })
    }

    if (result.outcome === 'idempotency_conflict') {
      deps.metrics.increment(COLLECTOR_METRICS.idempotencyConflict, { site_id: config.siteId })
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'An event id in this batch was already accepted with different content.',
        {
          details: {
            reason: 'event_id_reused',
            index: result.index,
            first_accepted_at: result.firstAcceptedAt,
          },
        },
      )
    }

    const accepted = result.results.filter((entry) => entry.enqueued).length
    const duplicate = result.results.length - accepted

    deps.metrics.increment(COLLECTOR_METRICS.eventsEnqueued, { site_id: config.siteId }, accepted)
    if (duplicate > 0) {
      deps.metrics.increment(
        COLLECTOR_METRICS.eventsDuplicate,
        { site_id: config.siteId },
        duplicate,
      )
    }

    // Only newly enqueued events count. A duplicate billed a second time is the
    // double-charge D-209 exists to prevent.
    const newlyBillable = result.results.reduce(
      (total, entry, index) =>
        entry.enqueued && classifications[index]?.billable === true ? total + 1 : total,
      0,
    )

    // Only newly enqueued events are counted, and only when there is a window to
    // count them into. The extension owns the failure boundary: Postgres remains
    // authoritative and the worker reconciles this counter (M6), so losing the
    // increment costs a limit check, not an event.
    if (deps.cloud && window !== null && newlyBillable > 0) {
      await deps.cloud.recordUsage({ config, window, newlyBillable, acceptedAt })
    }

    // Realtime lives in its own failure boundary (§7.2): the historical event is
    // accepted and must stay accepted whatever happens here.
    //
    // **Every accepted batch refreshes presence** (ADR-0035, D6), not only one
    // that carries a page view. A custom event, a conversion, an interaction or
    // a web vital used to refresh nothing at all, so a visitor clicking through
    // a single-page checkout for four minutes was, to presence, somebody who
    // left after their first pageview. Umami reads its whole event table for
    // exactly this reason; page-view-only was the unusual shape, not this.
    try {
      // The *feed* stays page-view-only, which is ADR-0024 D3's rule and not
      // this ADR's to revisit: custom events on a live feed would need a
      // billing-class-aware decision nobody has asked for. So a batch with no
      // page view refreshes presence and writes no feed entry — the shape the
      // heartbeat path has always had.
      const lastPageView = lastPageViewOf(batch)

      // A retry the queue recognised as a duplicate contributes nothing to the
      // feed — the visitor is still present (the touch below runs either way),
      // but the page view already happened once and is already on it. A newly
      // enqueued view carries its *validated* occurred_at, the same instant the
      // persisted row will hold, and its source **out of the envelope that was
      // queued** — the same canonical domain, the same self-referral rule
      // (ADR-0028) and the same ingest inferences, so the live feed and the
      // report it is the leading edge of never disagree about a visitor's
      // source.
      const feedTime = lastPageView === null ? undefined : times[lastPageView.index]?.time
      const feed =
        lastPageView !== null &&
        result.results[lastPageView.index]?.enqueued === true &&
        feedTime?.accepted === true
          ? {
              eventId: lastPageView.event.event_id,
              occurredAt: feedTime.occurredAt,
              referrer: envelopes[lastPageView.index]?.source.referrer_domain ?? null,
            }
          : undefined

      // The visitor is derived once and reused for the id and the device type,
      // so the raw address enters `deriveVisitorContext` a single time and
      // nothing that holds one comes back out.
      const visitor = deriveVisitorContext({
        ip: rawAddress ?? 'unknown',
        userAgent: gate.userAgent,
        siteId: config.siteId,
        occurredAt: acceptedAt,
        key: deps.identityKey,
      })
      // Only a page view moves the visitor's recorded page. A custom event may
      // carry page context, but "what page are they on" is a question page views
      // answer; the HSET omits the field entirely when there is none, so a
      // page-less batch refreshes liveness without blanking a known path.
      const page =
        lastPageView === null
          ? null
          : presencePageFrom(lastPageView.event.page, settings.redactQueryKeys)
      await deps.realtime.touchVisitor({
        siteId: config.siteId,
        visitorId: visitor.anonymousId,
        at: acceptedAt,
        // Country and city both come from the same GeoLite2 lookup the persisted
        // envelope uses, and browser/os from the same UA classification — no
        // second parser and no second answer. The city is admitted to the
        // realtime store by ADR-0024 and reaches the private snapshot only.
        country: gate.client.country ?? null,
        city: gate.client.city ?? null,
        deviceType: visitor.deviceType,
        browser: visitor.browser,
        os: visitor.os,
        ...(page ? { page } : {}),
        ...(feed ? { feed } : {}),
      })
    } catch {
      deps.metrics.increment(COLLECTOR_METRICS.realtimeDegraded, { site_id: config.siteId })
    }

    return c.json({ accepted, duplicate }, 202)
  })

  return routes
}

interface BuildPersistedInput {
  readonly event: ClientEvent
  readonly batch: EventBatch
  readonly gateConfig: SiteIngestConfig
  readonly redactQueryKeys: readonly string[]
  /** The site's own linking switch (ADR-0064 D4a). Off removes `order_id`. */
  readonly attributedRevenue: boolean
  readonly occurredAt: Date
  readonly clockSkewed: boolean
  readonly receivedAt: Date
  readonly acceptedAt: Date
  readonly billable: boolean
  /** The published rule this event was established as coming from, if any. */
  readonly rule: { readonly ruleId: string; readonly version: number } | null
  readonly usageWindowStart: Date
  readonly grace: boolean
  readonly deps: CollectorDeps
  readonly userAgent: string | null
  readonly country: string | null
  readonly city: string | null
  readonly rawAddress: string | null
}

/**
 * Builds the server envelope (docs snapshot 02 §8).
 *
 * The raw address enters `deriveVisitorContext` and does not come back: the
 * returned structure has no field that could hold one, so nothing assembled from
 * it can carry an IP into the queue payload.
 */
function buildPersistedEvent(input: BuildPersistedInput): PersistedEvent {
  const { event, batch, gateConfig: config, occurredAt, acceptedAt, deps, redactQueryKeys } = input

  const visitor = deriveVisitorContext({
    ip: input.rawAddress ?? 'unknown',
    userAgent: input.userAgent,
    siteId: config.siteId,
    // The *validated* timestamp, so a clamped future event lands in the day the
    // server accepted it rather than one the visitor invented (D-102).
    occurredAt,
    key: deps.identityKey,
    geo: { country: input.country, city: input.city },
  })

  const page = event.page ? sanitizeUrl(event.page.url, { redactQueryKeys }) : null
  // The site's own hosts are not an acquisition source, and one source has one
  // spelling (ADR-0028). Both rules are applied here, on the way in, because
  // `referrer_domain` is a rollup grouping key: `sources_15m` has already grouped
  // by it before any reader exists to repair it.
  const referrer = resolveReferrer(event.referrer, {
    siteDomains: config.allowedDomains,
    pageUrl: event.page?.url,
  })
  const attribution = attributionFrom(page)
  // A paid click that arrives with no referrer is not Direct (ADR-0075, D-C1).
  // The ad platform's interstitial is cross-origin and the browser's default
  // referrer policy removes the header outright, so the only surviving evidence
  // of the channel is the click id the platform put in the landing URL. It is
  // read here, on the way in, for the reason ADR-0028 gives for resolving the
  // referrer here: `referrer_domain` is the rollup grouping key and
  // `sources_15m` has already grouped by it before any reader exists to repair
  // it. Repairing it at read time would have to be repeated in every future
  // reader — the sources report, the session fact's entry attribution, revenue
  // first/last touch — instead of once.
  //
  // **A self-referral still wins.** An internal navigation that carries a
  // leftover `fbclid` in the URL — a visitor who landed from an ad and then
  // clicked through to a second page whose link kept the parameter — is not a
  // new acquisition, and `isSelf` is the guard that says so. Only a referrer
  // that resolved to *nothing* may be filled in this way.
  //
  // The same guard admits the `?ref=` tag (ADR-0077, D-R1), and it is tried
  // FIRST: a label a linking site or a customer wrote by hand names the source
  // more precisely than a click id, which names only the platform that served
  // the ad. Both are inferences on a referrer that resolved to nothing, so at
  // most one of the two provenance columns is ever set on a row.
  const derivable = referrer.domain === null && !referrer.isSelf
  const ref = derivable ? refSourceOf(page) : null
  const clickId = derivable && ref === null ? clickIdSourceOf(page) : null
  const aiUtmDomain =
    derivable && ref === null && clickId === null ? aiUtmSourceOf(attribution) : null
  const source = {
    referrer_domain: ref?.domain ?? clickId?.domain ?? aiUtmDomain ?? referrer.domain,
    referrer_path: referrer.path,
    click_id_source: clickId?.key ?? null,
    ref_source: ref?.value ?? null,
    ...attribution,
  }
  // Two passes, and the order matters: sanitization decides what may be stored
  // at all, and the linking rule then decides whether what survived may be a
  // hint. Re-checked here rather than trusted from the browser (ADR-0064 D4a,
  // server half) — the tracker already strips it, and this is the half that
  // holds when the client is not the tracker. The counter is per site because a
  // sustained rate names the site running a stale bundle.
  const sanitized = event.properties
    ? sanitizeProperties(event.properties, { redactQueryKeys }).properties
    : {}
  const linking = stripLinkingHints(sanitized, input.attributedRevenue)
  if (linking.dropped.length > 0) {
    deps.metrics.increment(COLLECTOR_METRICS.linkingHintFiltered, { site_id: config.siteId })
  }
  const properties = linking.properties

  const userId =
    event.type === 'identify'
      ? externalUserIdHash({
          siteId: config.siteId,
          externalUserId: event.external_user_id,
          key: deps.identityKey,
        }).userId
      : null

  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: event.event_id,
    site_id: config.siteId,
    type: event.type,
    name: 'name' in event ? event.name : null,

    occurred_at: occurredAt.toISOString(),
    received_at: input.receivedAt.toISOString(),
    accepted_at: acceptedAt.toISOString(),
    clock_skewed: input.clockSkewed,

    ingest_generation: config.ingestGeneration,
    billing_user_id: config.billingUserId,
    billing_assignment_version: config.billingAssignmentVersion,
    usage_window_start: input.usageWindowStart.toISOString(),
    // Minted by the worker's compute-or-create; the collector performs no
    // Postgres write on the ingest path (plan M6 item 12).
    usage_window_id: null,
    billing_grace: input.grace,
    billable: input.billable,
    // Server-set: `rule_id` is only ever the id of a rule this site actually
    // publishes -- never the one the client claimed (ADR-0034, D5).
    rule_id: input.rule?.ruleId ?? null,
    rule_version: input.rule?.version ?? null,

    anonymous_id: visitor.anonymousId,
    // The canonical analytics session is rebuilt by the sessionizer (M8); the
    // client's hint is hashed site-scoped so it cannot be a cross-site id.
    session_id: event.client_session_id
      ? clientSessionHash({
          siteId: config.siteId,
          clientSessionId: event.client_session_id,
          key: deps.identityKey,
        })
      : null,
    user_id: userId,

    page: page ? { url: page.url, path: page.path, title: event.page?.title ?? null } : null,

    source,

    properties,

    context: {
      sdk: batch.context.sdk,
      sdk_version: batch.context.sdk_version,
      device_type: visitor.deviceType,
      browser: visitor.browser,
      os: visitor.os,
      country: visitor.country,
      city: visitor.city,
    },

    // Re-redacted server-side (ADR-0057 D6): the contract's "already redacted
    // and truncated by the tracker" is an assumption about the client, and the
    // rule that actually holds is this one.
    interaction: event.type === 'interaction' ? sanitizeInteraction(event.interaction) : null,
    engagement: event.type === 'engagement' ? event.engagement : null,
    web_vital: event.type === 'web_vital' ? event.web_vital : null,
  }
}
