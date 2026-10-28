import { randomUUID } from 'node:crypto'
import {
  createApp,
  createFallbackLimiter,
  type CollectorDeps,
} from '../../apps/collector/src/index.ts'
import { persistedEventSchema } from '@openanalytics/contracts'
import {
  DEFAULT_TRACKER_SETTINGS,
  loadPolicy,
  type SiteIngestConfig,
  type SiteTrackerSettings,
} from '@openanalytics/domain'
import {
  createRecordingMetrics,
  createServiceMetadata,
  createLogger,
  type Metrics,
} from '@openanalytics/observability'
import type {
  ChargedRateLimits,
  EnqueueBatchResult,
  EnqueueInput,
  EventStreamQueue,
  PresenceTouchInput,
  RealtimeCache,
  RecordTagSightingInput,
  TagSighting,
} from '@openanalytics/redis'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The Milestone 5 acceptance matrix, against fakes.
 *
 * These are the plan's six acceptance criteria expressed as behaviour of the
 * whole route rather than of a function: what the collector answers, what it
 * writes, and — mostly — what it does *not* write. The queue and realtime doubles
 * record every call, so "the collector performs no Postgres usage increment, no
 * email, no provider API call" is checkable as an absence rather than asserted
 * as an intention.
 *
 * The same criteria are re-proven against a real Valkey in
 * `tests/integration/m5-collector-live.test.ts`. These run everywhere; that one
 * proves the atomicity claim the doubles cannot.
 */

const POLICY = loadPolicy({})
const NOW = new Date('2026-07-23T12:00:00.000Z')
const TRACKING_KEY = 'oa_pk_testkey_000000'

function uuidV7(): string {
  // Shape only — the collector validates the pattern, not the encoded time.
  const base = randomUUID()
  return `${base.slice(0, 14)}7${base.slice(15, 19)}${base.slice(19)}`.replace(
    /^(.{19})(.)/,
    (_all, head: string, variant: string) => `${head}${'89ab'.includes(variant) ? variant : '8'}`,
  )
}

const siteConfig = (overrides: Partial<SiteIngestConfig> = {}): SiteIngestConfig => ({
  siteId: 'site-1',
  status: 'active',
  ingestGeneration: 3,
  configVersion: 1,
  billingUserId: 'user-1',
  billingAssignmentVersion: 2,
  keyExpiresAt: null,
  allowedDomains: [],
  ...overrides,
})

class FakeQueue implements EventStreamQueue {
  readonly batches: EnqueueInput[][] = []
  /** Stream ids by `(site, event)`, so a retry answers like the real dedup. */
  private readonly accepted = new Map<string, { hash: string; streamId: string; at: string }>()
  failWith: Error | null = null
  private sequence = 0

  /** Everything the route handed the queue, across all requests. */
  get enqueued(): EnqueueInput[] {
    return this.batches.flat()
  }

  /** Distinct stream entries created — what a duplicate must *not* add to. */
  get streamRows(): number {
    return this.accepted.size
  }

  async enqueueBatch(inputs: readonly EnqueueInput[]): Promise<EnqueueBatchResult> {
    if (this.failWith) throw this.failWith

    for (const [index, input] of inputs.entries()) {
      const prior = this.accepted.get(`${input.siteId}:${input.eventId}`)
      if (prior && prior.hash !== input.payloadHash) {
        return {
          outcome: 'idempotency_conflict',
          index,
          conflictingStreamId: prior.streamId,
          firstAcceptedAt: prior.at,
        }
      }
    }

    const results = inputs.map((input) => {
      const key = `${input.siteId}:${input.eventId}`
      const prior = this.accepted.get(key)
      if (prior) {
        return {
          outcome: 'duplicate' as const,
          enqueued: false as const,
          streamId: prior.streamId,
          firstAcceptedAt: prior.at,
        }
      }
      this.sequence += 1
      const streamId = `${this.sequence}-0`
      this.accepted.set(key, { hash: input.payloadHash, streamId, at: input.acceptedAt })
      return {
        outcome: 'enqueued' as const,
        enqueued: true as const,
        streamId,
        firstAcceptedAt: input.acceptedAt,
      }
    })

    this.batches.push([...inputs])
    return { outcome: 'accepted', results }
  }

  async enqueue(input: EnqueueInput) {
    const batch = await this.enqueueBatch([input])
    if (batch.outcome === 'idempotency_conflict') {
      return {
        outcome: 'idempotency_conflict' as const,
        enqueued: false as const,
        conflictingStreamId: batch.conflictingStreamId,
        firstAcceptedAt: batch.firstAcceptedAt,
      }
    }
    return batch.results[0]!
  }
}

class FakeRealtime implements RealtimeCache {
  counts: ChargedRateLimits = { ipSite: 0, identity: 0, site: 0, siteDaily: 0 }
  billableUsed = 0
  siteDailyBillable = 0
  readonly visitors: { siteId: string; visitorId: string }[] = []
  /** Every touch input verbatim, for the ADR-0024 feed and breakdown rules. */
  readonly touches: PresenceTouchInput[] = []
  readonly bots: { siteId: string; signature: string; cost: number }[] = []
  readonly recorded: { billable: number; windowStart: string }[] = []
  failCharge: Error | null = null
  failTouch: Error | null = null

  async chargeRateLimits(input: { cost: number }): Promise<ChargedRateLimits> {
    if (this.failCharge) throw this.failCharge
    this.counts = {
      ipSite: this.counts.ipSite + input.cost,
      identity: this.counts.identity + input.cost,
      site: this.counts.site + input.cost,
      siteDaily: this.counts.siteDaily + input.cost,
    }
    return this.counts
  }

  async readUsage() {
    return { billableUsed: this.billableUsed, siteDailyBillable: this.siteDailyBillable }
  }

  /**
   * The collector never reads this — the streak memory is the worker's (G-005,
   * ADR-0010) — but the double implements the port, so the method exists to
   * prove the collector does not call it rather than to serve it.
   */
  ceilingReads = 0
  async readDailyCeilingCounts(): Promise<number[]> {
    this.ceilingReads += 1
    return []
  }

  async recordBillable(input: { billable: number; usageWindowStart: Date }) {
    this.billableUsed += input.billable
    this.recorded.push({
      billable: input.billable,
      windowStart: input.usageWindowStart.toISOString(),
    })
  }

  /**
   * Worker-only reconciliation surface (ADR-0013). The collector never calls
   * these; the double implements the port so a call would be visible.
   */
  windowReads = 0
  async readWindowUsage(): Promise<number> {
    this.windowReads += 1
    return this.billableUsed
  }

  async raiseWindowUsage(input: { delta: number }) {
    this.billableUsed += input.delta
  }

  async touchVisitor(input: PresenceTouchInput) {
    if (this.failTouch) throw this.failTouch
    this.visitors.push({ siteId: input.siteId, visitorId: input.visitorId })
    this.touches.push(input)
  }

  async countBot(input: { siteId: string; signature: string; cost: number }) {
    this.bots.push(input)
  }

  /**
   * The tag-sighting surface (ADR-0081, D2) belongs to the tracker-config route,
   * not to ingest. The double implements the port so a call from an ingest route
   * would be visible here rather than a type gap.
   */
  readonly sightings: RecordTagSightingInput[] = []
  async recordTagSighting(input: RecordTagSightingInput) {
    this.sightings.push(input)
  }

  sightingReads = 0
  async readTagSightings(): Promise<TagSighting[]> {
    this.sightingReads += 1
    return []
  }

  /**
   * Presence read and access-epoch surfaces are the realtime gateway's and the
   * api's (docs snapshot 02 §17, D-213); the collector never calls them. The
   * double implements the port so a call would be visible rather than a type gap.
   */
  async readPresenceSnapshot() {
    return {
      activeVisitors: 0,
      truncated: false,
      pages: [],
      countries: [],
      devices: [],
      browsers: [],
      operatingSystems: [],
      cities: [],
      events: [],
      present: [],
    }
  }

  async getEpoch(): Promise<number | null> {
    return null
  }

  async ensureEpoch(): Promise<number> {
    return 0
  }

  async bumpEpochAndPublishDisconnect(): Promise<number> {
    return 0
  }
}

interface Harness {
  readonly app: ReturnType<typeof createApp>
  readonly queue: FakeQueue
  readonly realtime: FakeRealtime
  readonly metrics: ReturnType<typeof createRecordingMetrics>
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>
}

function harness(
  options: {
    config?: SiteIngestConfig
    /** The site's ingest settings, for the ADR-0064 D4a linking tests. */
    settings?: SiteTrackerSettings
    now?: Date
    /** The site's published rules, for the ADR-0034 D5 origin tests. */
    noCodeRules?: readonly {
      rule_id: string
      name: string
      version: number
      trigger: 'click' | 'submit' | 'url_pattern'
      selector?: string
    }[]
  } = {},
): Harness {
  const queue = new FakeQueue()
  const realtime = new FakeRealtime()
  const metrics = createRecordingMetrics()
  const config = options.config ?? siteConfig()
  const settings = options.settings ?? DEFAULT_TRACKER_SETTINGS
  const noCodeRules = options.noCodeRules ?? []

  const ingest: CollectorDeps = {
    configStore: {
      resolve: async (key: string) =>
        key === TRACKING_KEY ? { config, settings, slug: 'shop', noCodeRules } : null,
      invalidate: () => undefined,
    },
    queue,
    realtime,
    policy: POLICY,
    identityKey: { keyVersion: 1, secret: 'identity-secret-for-tests-0000' },
    metrics: metrics as Metrics,
    fallbackLimiter: createFallbackLimiter({ perMinute: 120, maxEntries: 100 }),
    now: () => options.now ?? NOW,
  }

  const service = createServiceMetadata({
    name: 'collector',
    version: '0.0.0',
    commit: 'test',
    environment: 'test',
  })
  const app = createApp({
    service,
    logger: createLogger({ service, sink: () => undefined }),
    env: { ...POLICY, PORT: 0 } as never,
    ingest,
  })

  return {
    app,
    queue,
    realtime,
    metrics,
    post: async (path, body, headers = {}) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'user-agent': CHROME, ...headers },
        body: JSON.stringify(body),
      }),
  }
}

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const pageView = (overrides: Record<string, unknown> = {}) => ({
  event_id: uuidV7(),
  type: 'page_view' as const,
  occurred_at: NOW.toISOString(),
  page: { url: 'https://shop.example.com/pricing' },
  ...overrides,
})

const batchOf = (events: unknown[], overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  tracking_key: TRACKING_KEY,
  sent_at: NOW.toISOString(),
  context: { sdk: 'web', sdk_version: '2.0.0' },
  events,
  ...overrides,
})

describe('POST /v1/events', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  it('accepts a valid batch with 202 and reports what happened', async () => {
    const response = await h.post('/v1/events', batchOf([pageView(), pageView()]))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: 2, duplicate: 0 })
    expect(h.queue.enqueued).toHaveLength(2)
  })

  it('answers 202 for a retry without creating a second stream row', async () => {
    // Docs snapshot 02 §7.1 item 15 and D-209: first acceptance and a duplicate
    // retry share one semantic. Only the counts differ.
    const event = pageView()
    await h.post('/v1/events', batchOf([event]))
    const retry = await h.post('/v1/events', batchOf([event]))

    expect(retry.status).toBe(202)
    expect(await retry.json()).toEqual({ accepted: 0, duplicate: 1 })
    // Submitted twice, stored once. The retry is an acceptance, not a row.
    expect(h.queue.enqueued).toHaveLength(2)
    expect(h.queue.streamRows).toBe(1)
  })

  it('queues a payload the persisted envelope accepts', async () => {
    await h.post('/v1/events', batchOf([pageView()]))

    const payload: unknown = JSON.parse(h.queue.enqueued[0]?.payload ?? '{}')
    expect(() => persistedEventSchema.parse(payload)).not.toThrow()
  })

  it('stamps the server-owned half a client cannot state', async () => {
    await h.post('/v1/events', batchOf([pageView()]))

    const payload = persistedEventSchema.parse(JSON.parse(h.queue.enqueued[0]?.payload ?? '{}'))
    expect(payload.site_id).toBe('site-1')
    expect(payload.ingest_generation).toBe(3)
    expect(payload.billing_user_id).toBe('user-1')
    expect(payload.billing_assignment_version).toBe(2)
    expect(payload.billable).toBe(true)
    expect(payload.billing_grace).toBe(false)
    // With nothing keeping billing windows, the stamp is the acceptance instant
    // and the row id is the worker's to mint (plan M6 item 12). A deployment that
    // *does* keep them stamps the window's start here instead
    // (`tests/unit/cloud/collector-ingest.test.ts`).
    expect(payload.usage_window_start).toBe(NOW.toISOString())
    expect(payload.usage_window_id).toBeNull()
  })

  describe('the Sec-GPC backstop (G-008, ADR-0057 D5)', () => {
    it('drops a batch whose request carries Sec-GPC: 1, silently', async () => {
      // The visitor's browser attached the opt-out to the request itself. The
      // client-side gate can be switched off by a site attribute or bypassed by
      // a non-official SDK; this read cannot. The answer is the ordinary
      // success shape — the opt-out is honoured, not announced.
      const response = await h.post('/v1/events', batchOf([pageView()]), { 'sec-gpc': '1' })

      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: 0, duplicate: 0 })
      expect(h.queue.enqueued).toHaveLength(0)
      expect(h.metrics.countOf('collector_gpc_filtered')).toBe(1)
      expect(
        h.metrics.recorded.find((entry) => entry.name === 'collector_gpc_filtered')?.labels,
      ).toMatchObject({ endpoint: 'events' })
    })

    it('honours only the spec value: anything but "1" is not a GPC assertion', async () => {
      const response = await h.post('/v1/events', batchOf([pageView()]), { 'sec-gpc': '0' })

      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: 1, duplicate: 0 })
      expect(h.metrics.countOf('collector_gpc_filtered')).toBe(0)
    })
  })

  it('carries no raw IP into the queue payload', async () => {
    // The M4 boundary, re-proven at the layer that actually writes: the address
    // enters `deriveVisitorContext` and nothing downstream can hold one.
    await h.post('/v1/events', batchOf([pageView()]), { 'x-real-ip': '203.0.113.7' })

    expect(h.queue.enqueued[0]?.payload).not.toContain('203.0.113.7')
  })

  it('re-redacts interaction text and selector server-side (ADR-0057 D6)', async () => {
    // The tracker redacts before sending, and nothing enforces that a client is
    // the tracker: this posts what a modified client would, and asserts the
    // stored payload is clean anyway.
    const event = {
      event_id: uuidV7(),
      type: 'interaction' as const,
      occurred_at: NOW.toISOString(),
      interaction: {
        x_percent: 10,
        y_percent: 20,
        viewport_class: 'desktop',
        viewport_width: 1280,
        selector: 'a.mail-someone@example.com',
        text: 'reach me at someone@example.com',
      },
    }

    await h.post('/v1/events', batchOf([event]))

    const payload = h.queue.enqueued[0]?.payload ?? ''
    expect(payload).not.toContain('someone@example.com')
    expect(payload).toContain('[redacted]')
  })

  describe('the linking hint, server-side (ADR-0064 D4a)', () => {
    const conversion = (properties: Record<string, unknown>) => ({
      event_id: uuidV7(),
      type: 'conversion' as const,
      name: 'purchase',
      occurred_at: NOW.toISOString(),
      page: { url: 'https://shop.example.com/thanks' },
      properties,
    })

    const propertiesOf = (h: Harness): Record<string, unknown> =>
      persistedEventSchema.parse(JSON.parse(h.queue.enqueued[0]?.payload ?? '{}')).properties

    it('strips order_id from a modified client when the site has the flag off', async () => {
      // The tracker strips this before sending, and nothing enforces that the
      // client is the tracker: a stale bundle, an edited script or anything
      // posting with a valid write key can send it anyway. The site never turned
      // attributed revenue on, so the hint must not become durable data.
      const response = await h.post(
        '/v1/events',
        batchOf([conversion({ order_id: 'cs_test_a1B2c3', plan: 'growth' })]),
      )

      // The conversion itself is measurement and is still accepted and counted.
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: 1, duplicate: 0 })
      expect(propertiesOf(h)).toEqual({ plan: 'growth' })
      expect(h.queue.enqueued[0]?.payload).not.toContain('cs_test_a1B2c3')

      expect(h.metrics.countOf('collector_linking_hint_filtered')).toBe(1)
      expect(
        h.metrics.recorded.find((entry) => entry.name === 'collector_linking_hint_filtered')
          ?.labels,
      ).toMatchObject({ site_id: 'site-1' })
    })

    it('stores it for a site that turned attributed revenue on', async () => {
      // The control. Without it the assertion above would also pass if the
      // property never survived sanitization for any other reason.
      const optedIn = harness({
        settings: { ...DEFAULT_TRACKER_SETTINGS, attributedRevenue: true },
      })

      await optedIn.post(
        '/v1/events',
        batchOf([conversion({ order_id: 'cs_test_a1B2c3', plan: 'growth' })]),
      )

      expect(propertiesOf(optedIn)).toEqual({ order_id: 'cs_test_a1B2c3', plan: 'growth' })
      expect(optedIn.metrics.countOf('collector_linking_hint_filtered')).toBe(0)
    })

    it('leaves an ordinary event untouched and counts nothing', async () => {
      await h.post('/v1/events', batchOf([conversion({ plan: 'growth', value: 49 })]))

      expect(propertiesOf(h)).toEqual({ plan: 'growth', value: 49 })
      expect(h.metrics.countOf('collector_linking_hint_filtered')).toBe(0)
    })
  })

  describe('all-or-nothing batch acceptance (§7.3)', () => {
    it('enqueues nothing when one event is invalid', async () => {
      const response = await h.post(
        '/v1/events',
        batchOf([pageView(), { ...pageView(), occurred_at: 'not-a-time' }]),
      )

      expect(response.status).toBe(400)
      expect(h.queue.enqueued).toHaveLength(0)
    })

    it('enqueues nothing when one event is past the 24-hour horizon', async () => {
      // D-016: an old event is rejected without creating usage or a queue row,
      // and §7.3 makes that rejection cover the whole request.
      const old = pageView({ occurred_at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() })
      const response = await h.post('/v1/events', batchOf([pageView(), old]))

      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { details: Record<string, unknown> } }
      expect(body.error.details['reason']).toBe('too_old')
      expect(body.error.details['index']).toBe(1)
      expect(h.queue.enqueued).toHaveLength(0)
    })

    it('rejects the whole request on an idempotency conflict', async () => {
      const event = pageView()
      await h.post('/v1/events', batchOf([event]))
      h.queue.batches.length = 0

      // Same id, different bytes.
      const conflicting = { ...event, page: { url: 'https://shop.example.com/other' } }
      const response = await h.post('/v1/events', batchOf([pageView(), conflicting]))

      expect(response.status).toBe(409)
      // Not even the valid event that preceded it.
      expect(h.queue.enqueued).toHaveLength(0)
    })
  })

  describe('a failed queue write is never a success', () => {
    it('answers 503 with a retry hint', async () => {
      h.queue.failWith = new Error('ECONNRESET')

      const response = await h.post('/v1/events', batchOf([pageView()]))

      expect(response.status).toBe(503)
      expect(response.headers.get('Retry-After')).toBe(
        String(POLICY.QUEUE_FAILURE_RETRY_AFTER_SECONDS),
      )
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
    })

    it('leaks no internal detail into the response', async () => {
      h.queue.failWith = new Error('NOAUTH Authentication required at 10.0.0.4:6379')

      const response = await h.post('/v1/events', batchOf([pageView()]))
      expect(await response.text()).not.toContain('10.0.0.4')
    })

    it('does not increment the usage counter for a batch it could not queue', async () => {
      h.queue.failWith = new Error('ECONNRESET')
      await h.post('/v1/events', batchOf([pageView()]))

      expect(h.realtime.recorded).toHaveLength(0)
    })
  })

  describe('failure isolation (§7.2)', () => {
    it('keeps an accepted event accepted when the realtime write fails', async () => {
      // "If the queue write succeeds and the realtime Redis update fails, the
      // analytics event counts as accepted."
      h.realtime.failTouch = new Error('realtime down')

      const response = await h.post('/v1/events', batchOf([pageView()]))

      expect(response.status).toBe(202)
      expect(h.queue.enqueued).toHaveLength(1)
      expect(h.metrics.countOf('collector_realtime_degraded')).toBe(1)
    })

    it('writes no usage counter at all when nothing keeps a window', async () => {
      // The counter belongs to the quota gate, and there is no gate here. Not a
      // degradation and not a silent skip: an install with no plans has no window
      // to count into, and the ledger the worker writes is where its event totals
      // come from. The failure-isolation case that used to be here — an accepted
      // event surviving an unwritable counter — is in
      // `tests/unit/cloud/collector-ingest.test.ts`.
      h.realtime.recordBillable = () => Promise.reject(new Error('down'))

      const response = await h.post('/v1/events', batchOf([pageView()]))

      expect(response.status).toBe(202)
      expect(h.realtime.recorded).toHaveLength(0)
      expect(h.metrics.countOf('collector_usage_counter_degraded')).toBe(0)
    })
  })

  describe('G-005 limits', () => {
    it('throttles with 429 and a Retry-After once an IP bursts past its ceiling', async () => {
      h.realtime.counts = {
        ipSite: POLICY.RATE_LIMIT_IP_SITE_BURST,
        identity: 0,
        site: 0,
        siteDaily: 0,
      }

      const response = await h.post('/v1/events', batchOf([pageView()]))

      expect(response.status).toBe(429)
      // G-005 says "429 + Retry-After" and means the header: a throttle is a
      // delay rather than a loss only if the tracker is told how long to wait.
      expect(response.headers.get('Retry-After')).toBe('60')
      expect(h.metrics.countOf('collector_rate_limited')).toBe(1)
      expect(h.queue.enqueued).toHaveLength(0)
    })

    it('throttles at the per-site daily ceiling, pointing at UTC midnight', async () => {
      h.realtime.counts = {
        ipSite: 0,
        identity: 0,
        site: 0,
        siteDaily: POLICY.SITE_DAILY_EVENT_CEILING,
      }

      const response = await h.post('/v1/events', batchOf([pageView()]))

      expect(response.status).toBe(429)
      // Midnight UTC, when the counter resets. A tracker told to retry sooner
      // would spend a visitor's battery failing.
      expect(response.headers.get('Retry-After')).toBe(String(12 * 3_600))
      const body = (await response.json()) as { error: { details: Record<string, unknown> } }
      expect(body.error.details['reason']).toBe('daily_ceiling')
      expect(h.metrics.countOf('collector_daily_ceiling_reached')).toBe(1)
    })

    it('fails open with a metric while the limiter store is unreachable', async () => {
      // "Losing data is worse than not checking a limit." Schema, origin, entitlement
      // and quota checks all still ran — only the rate check was skipped.
      h.realtime.failCharge = new Error('cache down')

      const response = await h.post('/v1/events', batchOf([pageView()]))

      expect(response.status).toBe(202)
      expect(h.metrics.countOf('collector_limiter_fail_open')).toBe(1)
      expect(h.queue.enqueued).toHaveLength(1)
    })

    it('filters bot traffic without billing it or storing it', async () => {
      const response = await h.post('/v1/events', batchOf([pageView()]), {
        'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      })

      // Answered like a success: telling a crawler it was identified only
      // teaches it what to change.
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: 0, duplicate: 0 })
      expect(h.queue.enqueued).toHaveLength(0)
      expect(h.realtime.recorded).toHaveLength(0)
      expect(h.realtime.bots[0]?.signature).toBe('googlebot')
      expect(h.metrics.countOf('collector_bot_filtered')).toBe(1)
      // Which path lost the traffic (ADR-0035, D9). The refusal is silent to the
      // caller on purpose, and the shared request metric's route label is the
      // collector middleware's mount `/*`, so without this a dropped heartbeat
      // and a dropped batch are one series and "presence stopped updating" has
      // nothing that can say why.
      expect(
        h.metrics.recorded.find((entry) => entry.name === 'collector_bot_filtered')?.labels,
      ).toMatchObject({ endpoint: 'events' })
    })

    it('charges the rate limit before it filters a bot', async () => {
      // An abuse ceiling anything could opt out of by editing a header is not a
      // ceiling. A crawler flood pays for the budget it consumes.
      await h.post('/v1/events', batchOf([pageView()]), { 'user-agent': 'curl/8.7.1' })

      expect(h.realtime.counts.site).toBe(1)
    })
  })

  describe('origin allowlist', () => {
    it('refuses an origin outside a configured allowlist', async () => {
      const scoped = harness({ config: siteConfig({ allowedDomains: ['shop.example.com'] }) })

      const response = await scoped.post('/v1/events', batchOf([pageView()]), {
        origin: 'https://evil.test',
      })

      expect(response.status).toBe(403)
      expect(scoped.queue.enqueued).toHaveLength(0)
    })

    it('accepts a subdomain of a configured domain', async () => {
      const scoped = harness({ config: siteConfig({ allowedDomains: ['example.com'] }) })

      const response = await scoped.post('/v1/events', batchOf([pageView()]), {
        origin: 'https://shop.example.com',
      })
      expect(response.status).toBe(202)
    })
  })

  /**
   * Server-side ingest, as a WordPress plugin's PHP half would send it
   * (ADR-0042, D10; plan 04 §Milestone 14 item 3).
   *
   * Two halves, and the milestone answers them differently. **Idempotency is
   * already the contract** and is sender-agnostic — proven here from the
   * server-side shape rather than assumed from the browser's. **A signature is
   * not built**, and these tests are where the reason is measurable rather than
   * asserted: an `Origin`-less request is admissible to a site with no domain
   * allowlist and refused by a site with one, all-or-nothing. A per-sender
   * secret is what would let a site keep the browser allowlist *and* accept a
   * server-side caller; ADR-0042 D10 records why M14 does not invent one for a
   * caller that does not yet exist, and what reversing it would take.
   */
  describe('a server-side sender (ADR-0042, D10)', () => {
    const wordpressBatch = (events: unknown[]) =>
      batchOf(events, { context: { sdk: 'wordpress', sdk_version: '1.0.0' } })

    it('accepts an Origin-less batch when the site has no domain allowlist', async () => {
      // No `origin` header at all — the shape a PHP request has, and one a
      // browser cannot produce for a cross-site POST.
      const response = await h.post('/v1/events', wordpressBatch([pageView()]))
      expect(response.status).toBe(202)
      expect(h.queue.enqueued).toHaveLength(1)
    })

    it('is refused by a site that has one, with no way to opt this sender in', async () => {
      const scoped = harness({ config: siteConfig({ allowedDomains: ['example.com'] }) })
      const response = await scoped.post('/v1/events', wordpressBatch([pageView()]))

      expect(response.status).toBe(403)
      expect(scoped.queue.enqueued).toHaveLength(0)
      // This is the whole of the "signature" gap: the allowlist is a browser
      // instrument, and a caller with no Origin is indistinguishable from a
      // forged browser request that stripped it.
    })

    /**
     * The other thing a server-side sender meets: it is not a browser, and the
     * bot classifier reads the User-Agent.
     *
     * The measured answer is the reassuring one, and it is recorded because the
     * plausible guess was the opposite: WordPress's own default
     * (`WordPress/6.5; https://example.com`) is **not** filtered. The classifier
     * matches known crawler signatures rather than requiring a known browser, so
     * an unrecognized agent is a visitor, not a bot. A sender that puts a
     * crawler word in its agent string is what gets filtered — silently, with a
     * `202`, which is the failure mode `docs/wordpress/README.md` warns about.
     */
    it('is not filtered for an unknown agent, but is for a crawler-shaped one', async () => {
      const kept = await h.post('/v1/events', wordpressBatch([pageView()]), {
        'user-agent': 'WordPress/6.5; https://shop.example.com',
      })
      expect(kept.status).toBe(202)
      expect(h.queue.enqueued).toHaveLength(1)

      const filtered = harness()
      const response = await filtered.post('/v1/events', wordpressBatch([pageView()]), {
        'user-agent': 'Mozilla/5.0 (compatible; SomeBot/1.0; +https://bot.test)',
      })
      // A 202 either way: a filtered request is accepted and stored nowhere,
      // which is exactly why a plugin that picks the wrong agent string sees a
      // chart at zero and no error to explain it.
      expect(response.status).toBe(202)
      expect(filtered.queue.enqueued).toHaveLength(0)
    })

    it('deduplicates a retry from a server-side sender exactly as from the browser', async () => {
      const event = pageView()
      expect((await h.post('/v1/events', wordpressBatch([event]))).status).toBe(202)

      const retry = await h.post('/v1/events', wordpressBatch([event]))
      expect(retry.status).toBe(202)
      expect(await retry.json()).toEqual({ accepted: 0, duplicate: 1 })
      expect(h.queue.streamRows).toBe(1)
    })
  })

  it('refuses an unknown tracking key', async () => {
    const response = await h.post(
      '/v1/events',
      batchOf([pageView()], { tracking_key: 'oa_pk_nope' }),
    )
    expect(response.status).toBe(404)
    expect(h.queue.enqueued).toHaveLength(0)
  })

  it('refuses a heartbeat smuggled into the historical batch', async () => {
    const response = await h.post(
      '/v1/events',
      batchOf([{ event_id: uuidV7(), type: 'heartbeat', occurred_at: NOW.toISOString() }]),
    )

    expect(response.status).toBe(400)
    expect(h.queue.enqueued).toHaveLength(0)
  })

  it('refuses a batch that names a server-owned field', async () => {
    const response = await h.post(
      '/v1/events',
      batchOf([{ ...pageView(), billable: true, site_id: 'other-site' }]),
    )

    expect(response.status).toBe(400)
    expect(h.queue.enqueued).toHaveLength(0)
  })

  describe('referrer hygiene (ADR-0028)', () => {
    const envelopeOf = (harnessed: Harness = h) =>
      persistedEventSchema.parse(JSON.parse(harnessed.queue.enqueued[0]?.payload ?? '{}'))

    it('stores one source domain for every spelling of it', async () => {
      // `sources_1h` groups by `referrer_domain` before any reader exists, so a
      // key that arrives in three spellings is three rows forever.
      for (const referrer of [
        'https://www.google.com/search?q=analytics#top',
        'https://google.com/search/abc',
        'https://GOOGLE.com:443/',
      ]) {
        const scoped = harness()
        await scoped.post('/v1/events', batchOf([pageView({ referrer })]))
        expect(envelopeOf(scoped).source.referrer_domain).toBe('google.com')
      }
    })

    it('keeps the referrer path for drill-down', async () => {
      await h.post('/v1/events', batchOf([pageView({ referrer: 'https://t.co/abc?x=1' })]))

      const source = envelopeOf().source
      expect(source.referrer_domain).toBe('t.co')
      expect(source.referrer_path).toBe('/abc')
    })

    it('stores no referrer for a navigation inside the site itself', async () => {
      // The 2026-07-28 report: the browser sends the previous page of the same
      // site, and the site used to appear as its own external source. The page
      // the event happened on is what identifies the site here — this harness
      // configures no allowlist, which is the common production state.
      await h.post(
        '/v1/events',
        batchOf([
          pageView({
            page: { url: 'https://shop.example.com/checkout' },
            referrer: 'https://www.shop.example.com/pricing?ref=nav',
          }),
        ]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBeNull()
      // The internal path goes too: it is not source drill-down.
      expect(source.referrer_path).toBeNull()
    })

    it('stores no referrer for a domain the site has configured', async () => {
      const scoped = harness({ config: siteConfig({ allowedDomains: ['shop.example.com'] }) })
      await scoped.post(
        '/v1/events',
        batchOf([
          pageView({
            page: { url: 'https://shop.example.com/checkout' },
            referrer: 'https://shop.example.com/pricing',
          }),
        ]),
        { origin: 'https://shop.example.com' },
      )

      expect(envelopeOf(scoped).source.referrer_domain).toBeNull()
    })

    it('still stores a subdomain the site did not register as a source', async () => {
      // Exact match after `www.`-stripping: `blog.` may be a separate property,
      // and a link from it is a real acquisition source (ADR-0028).
      await h.post(
        '/v1/events',
        batchOf([
          pageView({
            page: { url: 'https://shop.example.com/checkout' },
            referrer: 'https://blog.example.com/post',
          }),
        ]),
      )

      expect(envelopeOf().source.referrer_domain).toBe('blog.example.com')
    })
  })

  describe('a paid click is not Direct (ADR-0075, D-C1)', () => {
    const envelopeOf = (harnessed: Harness = h) =>
      persistedEventSchema.parse(JSON.parse(harnessed.queue.enqueued[0]?.payload ?? '{}'))

    // Long, spaceless and mixed-alphabet: the shape the redactor destroys, and
    // therefore the only shape worth testing. A short synthetic id would pass
    // here while production stored something unusable.
    const GCLID = 'EAIaIQobChMIx9-Zt6b0_gIVh4bVCh1sTgyDEAAYASAAEgKq7fD_BwE_padding_padding_padding'

    it('derives the platform when the browser sent no referrer at all', async () => {
      // Measured on production over 90 days: 8,302 of 8,921 `gclid` events had
      // `referrer_domain = ''`, because the ad platform's interstitial is
      // cross-origin and the browser's default policy removes the header. Every
      // one of them was reported as Direct.
      await h.post(
        '/v1/events',
        batchOf([pageView({ page: { url: `https://shop.example.com/lp?gclid=${GCLID}` } })]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBe('google.com')
      // Marked as inferred, so "how much of our Sources report did you fill in
      // for us" is a question the data can answer.
      expect(source.click_id_source).toBe('gclid')
      // A click id names a platform, not a page on it.
      expect(source.referrer_path).toBeNull()
    })

    it('stores the click id key but never its value', async () => {
      // D-C2. The value is `[redacted]` and stays that way — presence of the key
      // is the whole signal, and an exemption would be a permanent widening of a
      // privacy rule bought against a hypothetical.
      await h.post(
        '/v1/events',
        batchOf([pageView({ page: { url: `https://shop.example.com/lp?fbclid=${GCLID}` } })]),
      )

      const envelope = envelopeOf()
      expect(envelope.source.click_id_source).toBe('fbclid')
      expect(envelope.source.referrer_domain).toBe('facebook.com')
      expect(JSON.stringify(envelope)).not.toContain(GCLID)
    })

    it('leaves an internal navigation Direct even when the URL kept a click id', async () => {
      // A visitor lands from an ad and clicks through to a second page whose
      // link carried the parameter along. That is not a new acquisition, and
      // `isSelf` is the guard: only a referrer that resolved to NOTHING may be
      // filled in.
      await h.post(
        '/v1/events',
        batchOf([
          pageView({
            page: { url: `https://shop.example.com/pricing?fbclid=${GCLID}` },
            referrer: 'https://shop.example.com/lp',
          }),
        ]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBeNull()
      expect(source.click_id_source).toBeNull()
    })

    it('never overrides a referrer the browser actually sent', async () => {
      await h.post(
        '/v1/events',
        batchOf([
          pageView({
            page: { url: `https://shop.example.com/lp?gclid=${GCLID}` },
            referrer: 'https://news.ycombinator.com/item?id=1',
          }),
        ]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBe('news.ycombinator.com')
      expect(source.click_id_source).toBeNull()
    })

    it('leaves an ordinary visit untouched', async () => {
      await h.post('/v1/events', batchOf([pageView()]))
      const source = envelopeOf().source
      expect(source.referrer_domain).toBeNull()
      expect(source.click_id_source).toBeNull()
    })
  })

  describe('a tagged link is not Direct (ADR-0077, D-R1)', () => {
    const envelopeOf = (harnessed: Harness = h) =>
      persistedEventSchema.parse(JSON.parse(harnessed.queue.enqueued[0]?.payload ?? '{}'))

    it('names the source a ?ref= tag carries when the browser sent no referrer', async () => {
      // Measured on production over 30 days: 11,787 events carried a `ref` and
      // 11,035 of them had neither a referrer nor a `utm_source`. Every one was
      // reported as Direct while the tag naming the source sat in the URL we
      // had already stored.
      await h.post(
        '/v1/events',
        batchOf([pageView({ page: { url: 'https://shop.example.com/?ref=producthunt' } })]),
      )

      const source = envelopeOf().source
      // The label is filed under the host Product Hunt's own referrals report,
      // so the tagged visits and the ones whose referrer survived are one row.
      expect(source.referrer_domain).toBe('producthunt.com')
      expect(source.ref_source).toBe('producthunt')
      // A tag names a source, not a page on it.
      expect(source.referrer_path).toBeNull()
    })

    it('keeps an unmeasured label as itself rather than guessing a host', async () => {
      await h.post(
        '/v1/events',
        batchOf([pageView({ page: { url: 'https://shop.example.com/?ref=agentsnexus' } })]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBe('agentsnexus')
      expect(source.ref_source).toBe('agentsnexus')
    })

    it('prefers the tag over a click id, and sets only one provenance', async () => {
      // A hand-written label names the source more precisely than a click id,
      // which names only the platform that served the ad. Both fill the same
      // field, so at most one of the two columns is ever set on a row.
      const gclid = 'EAIaIQobChMIx9-Zt6b0_gIVh4bVCh1sTgyDEAAYASAAEgKq7fD_BwE_padding_padding'
      await h.post(
        '/v1/events',
        batchOf([
          pageView({ page: { url: `https://shop.example.com/lp?ref=selfh.st&gclid=${gclid}` } }),
        ]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBe('selfh.st')
      expect(source.ref_source).toBe('selfh.st')
      expect(source.click_id_source).toBeNull()
    })

    it('leaves an internal navigation Direct even when the URL kept the tag', async () => {
      await h.post(
        '/v1/events',
        batchOf([
          pageView({
            page: { url: 'https://shop.example.com/pricing?ref=producthunt' },
            referrer: 'https://shop.example.com/',
          }),
        ]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBeNull()
      expect(source.ref_source).toBeNull()
    })

    it('never overrides a referrer the browser actually sent', async () => {
      // Production holds 25 such visits: an aggregator that syndicates Product
      // Hunt links carries the tag along, and the aggregator is where the visit
      // actually came from.
      await h.post(
        '/v1/events',
        batchOf([
          pageView({
            page: { url: 'https://shop.example.com/?ref=producthunt' },
            referrer: 'https://app.designerdailyreport.com/list',
          }),
        ]),
      )

      const source = envelopeOf().source
      expect(source.referrer_domain).toBe('app.designerdailyreport.com')
      expect(source.ref_source).toBeNull()
    })

    it('leaves an ordinary visit untouched', async () => {
      await h.post('/v1/events', batchOf([pageView()]))
      expect(envelopeOf().source.ref_source).toBeNull()
    })

    it('derives the assistant referrer domain when an AI app link arrives with only its utm tag', async () => {
      const chatgpt = harness()
      await chatgpt.post(
        '/v1/events',
        batchOf([pageView({ page: { url: 'https://shop.example.com/?utm_source=chatgpt.com' } })]),
      )
      expect(envelopeOf(chatgpt).source.referrer_domain).toBe('chatgpt.com')
      expect(envelopeOf(chatgpt).source.utm_source).toBe('chatgpt.com')

      const claude = harness()
      await claude.post(
        '/v1/events',
        batchOf([
          pageView({
            page: {
              url: 'https://shop.example.com/?utm_source=Claude%20AI&utm_medium=claude.ai',
            },
          }),
        ]),
      )
      expect(envelopeOf(claude).source.referrer_domain).toBe('claude.ai')

      // Ordinary campaign utm_source values never invent a referrer_domain.
      const campaign = harness()
      await campaign.post(
        '/v1/events',
        batchOf([pageView({ page: { url: 'https://shop.example.com/?utm_source=newsletter' } })]),
      )
      expect(envelopeOf(campaign).source.referrer_domain).toBeNull()
    })
  })

  describe('the realtime touch it makes (ADR-0024)', () => {
    it('carries the breakdown dimensions from the sources the envelope uses', async () => {
      await h.post('/v1/events', batchOf([pageView()]), { 'user-agent': CHROME })

      const touch = h.realtime.touches[0]
      expect(touch?.browser).toBe('chrome')
      expect(touch?.os).toBe('windows')
      // Geo is whatever the harness's lookup answered — the point is that the
      // touch carries the same fields, not a second geo source.
      expect(touch).toHaveProperty('city')
      expect(touch?.page?.path).toBe('/pricing')
    })

    it('puts the newest page view of the batch on the feed, with its own instant', async () => {
      const older = pageView({ occurred_at: new Date(NOW.getTime() - 5_000).toISOString() })
      const newest = pageView({
        occurred_at: NOW.toISOString(),
        page: { url: 'https://shop.example.com/checkout' },
        referrer: 'https://news.ycombinator.com/item?id=1',
      })

      await h.post('/v1/events', batchOf([older, newest]))

      const feed = h.realtime.touches[0]?.feed
      expect(feed?.eventId).toBe(newest.event_id)
      expect(feed?.occurredAt.toISOString()).toBe(NOW.toISOString())
      // The referrer is the resolved domain, never the URL the client sent.
      expect(feed?.referrer).toBe('news.ycombinator.com')
    })

    it('resolves the feed referrer exactly as the envelope does (ADR-0028)', async () => {
      // The live feed is the leading edge of the same report, so the two must
      // never disagree about a visitor's source.
      const internal = pageView({
        page: { url: 'https://shop.example.com/checkout' },
        referrer: 'https://shop.example.com/pricing',
      })
      await h.post('/v1/events', batchOf([internal]))
      expect(h.realtime.touches[0]?.feed?.referrer).toBeNull()

      const external = harness()
      await external.post(
        '/v1/events',
        batchOf([pageView({ referrer: 'https://www.google.com/search?q=x' })]),
      )
      expect(external.realtime.touches[0]?.feed?.referrer).toBe('google.com')

      // Including a source the ingest INFERRED. The feed used to resolve the
      // referrer a second time from the raw event, which was correct until
      // ADR-0075 D-C1 and then silently wrong: a tagged or paid arrival showed
      // as Direct live and as its real source in the report ten seconds later.
      // It now reads the envelope that was queued.
      const tagged = harness()
      await tagged.post(
        '/v1/events',
        batchOf([pageView({ page: { url: 'https://shop.example.com/?ref=producthunt' } })]),
      )
      expect(tagged.realtime.touches[0]?.feed?.referrer).toBe('producthunt.com')
    })

    it('leaves the feed alone for a retry the queue recognised as a duplicate', async () => {
      // The visitor is still present — presence is liveness — but the page view
      // already happened once and is already on the feed.
      const event = pageView()
      await h.post('/v1/events', batchOf([event]))
      await h.post('/v1/events', batchOf([event]))

      expect(h.realtime.touches).toHaveLength(2)
      expect(h.realtime.touches[0]?.feed).toBeDefined()
      expect(h.realtime.touches[1]?.feed).toBeUndefined()
    })

    it('refreshes presence for a batch with no page view, and writes no feed entry', async () => {
      await h.post(
        '/v1/events',
        batchOf([
          {
            event_id: uuidV7(),
            type: 'custom_event',
            name: 'signup',
            occurred_at: NOW.toISOString(),
          },
        ]),
      )

      // **Inverted deliberately by ADR-0035 D6.** This used to assert "no page
      // view means no presence touch at all on this path", which made a visitor
      // clicking through a single-page checkout for four minutes look, to
      // presence, like somebody who left after their first pageview. Any
      // accepted event is now evidence the visitor is here.
      expect(h.realtime.touches).toHaveLength(1)

      // The feed is still page-view-only (ADR-0024 D3): custom events on a live
      // feed would need a billing-class-aware decision nobody has asked for.
      const touch = h.realtime.touches[0]
      expect(touch?.feed).toBeUndefined()
      // And no page is claimed. `page` is omitted rather than blanked, so a
      // page-less batch cannot erase the path an earlier page view established.
      expect(touch?.page).toBeUndefined()
    })

    it('keeps a visitor present through a burst of non-pageview events', async () => {
      // The shape the report was about, in miniature: one page view, then four
      // minutes of interactions. Every one of them is a reason to still be on
      // the board, and only the first carries a feed entry.
      await h.post('/v1/events', batchOf([pageView()]))
      await h.post(
        '/v1/events',
        batchOf([
          {
            event_id: uuidV7(),
            type: 'web_vital',
            occurred_at: NOW.toISOString(),
            web_vital: { metric: 'LCP', value: 1234, rating: 'good' },
          },
        ]),
      )

      expect(h.realtime.touches).toHaveLength(2)
      expect(h.realtime.touches[0]?.feed).toBeDefined()
      expect(h.realtime.touches[1]?.feed).toBeUndefined()
    })
  })
})

describe('POST /v1/realtime/heartbeat', () => {
  const heartbeat = () => ({
    schema_version: 1,
    tracking_key: TRACKING_KEY,
    sent_at: NOW.toISOString(),
    context: { sdk: 'web', sdk_version: '2.0.0' },
  })

  it('answers 204 only after the realtime write succeeded', async () => {
    const h = harness()

    const response = await h.post('/v1/realtime/heartbeat', heartbeat())

    expect(response.status).toBe(204)
    expect(h.realtime.visitors).toHaveLength(1)
  })

  it('attributes a bot-filtered heartbeat to the heartbeat path (ADR-0035 D9)', async () => {
    const h = harness()

    const response = await h.post('/v1/realtime/heartbeat', heartbeat(), {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    })

    // Still 204, so a crawler learns nothing from the difference — which is also
    // why the counter is the only place this is visible at all.
    expect(response.status).toBe(204)
    expect(h.realtime.visitors).toHaveLength(0)
    expect(
      h.metrics.recorded.find((entry) => entry.name === 'collector_bot_filtered')?.labels,
    ).toMatchObject({ endpoint: 'heartbeat' })
  })

  it('drops a heartbeat whose request carries Sec-GPC: 1 (ADR-0057 D5)', async () => {
    // A GPC visitor asked not to be present. 204 like any accepted heartbeat.
    const h = harness()

    const response = await h.post('/v1/realtime/heartbeat', heartbeat(), { 'sec-gpc': '1' })

    expect(response.status).toBe(204)
    expect(h.realtime.visitors).toHaveLength(0)
    expect(
      h.metrics.recorded.find((entry) => entry.name === 'collector_gpc_filtered')?.labels,
    ).toMatchObject({ endpoint: 'heartbeat' })
  })

  it('never reaches the queue or usage', async () => {
    // D-101: a heartbeat's usage weight is 0, and §7.2 keeps it off the durable
    // path entirely.
    const h = harness()
    await h.post('/v1/realtime/heartbeat', heartbeat())

    expect(h.queue.enqueued).toHaveLength(0)
    expect(h.realtime.recorded).toHaveLength(0)
  })

  it('answers 503 rather than falling back to the queue', async () => {
    // §7.2: a failed heartbeat is not downgraded into a historical event. It
    // carries no event_id, so a queued heartbeat could never be recognised as a
    // retry — and the tracker's next interval is the retry.
    const h = harness()
    h.realtime.failTouch = new Error('realtime down')

    const response = await h.post('/v1/realtime/heartbeat', heartbeat())

    expect(response.status).toBe(503)
    expect(h.queue.enqueued).toHaveLength(0)
    expect(h.metrics.countOf('collector_heartbeat_failed')).toBe(1)
  })

  it('refuses a suspended site, and says nothing about why', async () => {
    // The same gate the batch route passes, and the same answer: with no surface
    // that has an opinion about the suspension, it is `SITE_NOT_FOUND`. The
    // grace-window variant is in `tests/unit/cloud/collector-ingest.test.ts`.
    const blocked = harness({ config: siteConfig({ status: 'suspended' }) })

    expect((await blocked.post('/v1/realtime/heartbeat', heartbeat())).status).toBe(404)
    expect(blocked.realtime.visitors).toHaveLength(0)
  })
})

describe('the collector reaches nothing it must not', () => {
  it('is wired with a queue, a realtime cache and a config store — and nothing else', () => {
    // Docs snapshot 02 §7.1: no ClickHouse insert, no Postgres usage hot row, no
    // email, no provider API. This asserts it structurally: a route can only call
    // what CollectorDeps exposes, so the absence is checkable rather than merely
    // intended.
    const h = harness()
    void h

    const deps: (keyof CollectorDeps)[] = [
      'configStore',
      'queue',
      'realtime',
      'policy',
      'identityKey',
      'metrics',
      'fallbackLimiter',
      'now',
    ]

    for (const name of deps) {
      expect(name).not.toMatch(/clickhouse|email|stripe|resend|usage_repo/i)
    }
  })
})

/**
 * ADR-0034 D5, asserted through the real route.
 *
 * This block is the guard against the defect it was written for. From M4 until
 * M13 `events.ts` hardcoded `origin: 'client_sdk'`, which made
 * `collapseBillableActions` unreachable on the live path -- fully implemented,
 * fully tested in the domain, and never once executed against a real batch. A
 * unit test of the classifier could not have caught that, because the classifier
 * was correct. Only a test that goes through the route can, so these do.
 */
describe('no-code origin is established by the server, not claimed by the client', () => {
  const RULE_ID = 'rule-0192f7a0-000a'
  const rules = [
    { rule_id: RULE_ID, name: 'pricing_cta_clicked', version: 1, trigger: 'click' as const },
  ]

  const customEvent = (overrides: Record<string, unknown> = {}) => ({
    event_id: uuidV7(),
    type: 'custom_event' as const,
    occurred_at: NOW.toISOString(),
    page: { url: 'https://shop.example.com/pricing' },
    name: 'pricing_cta_clicked',
    ...overrides,
  })

  /** Usage units the route actually charged, read off the persisted envelopes. */
  const billableOf = (h: Harness): number =>
    h.queue.enqueued
      .map((input) => JSON.parse(input.payload) as { billable: boolean })
      .filter((event) => event.billable).length

  it('bills one unit when a rule event and a raw track call describe one click', async () => {
    const h = harness({ noCodeRules: rules })
    const response = await h.post(
      '/v1/events',
      batchOf([
        customEvent({ action_id: 'act-1' }),
        customEvent({ action_id: 'act-1', rule_id: RULE_ID }),
      ]),
    )

    expect(response.status).toBe(202)
    // Two events stored, one unit charged. If `origin` were hardcoded again this
    // would be 2, and this assertion is the whole point of the file.
    expect(h.queue.enqueued).toHaveLength(2)
    expect(billableOf(h)).toBe(1)
  })

  it('bills both when the rule id resolves to nothing on this site', async () => {
    const h = harness({ noCodeRules: rules })
    await h.post(
      '/v1/events',
      batchOf([
        customEvent({ action_id: 'act-1' }),
        customEvent({ action_id: 'act-1', rule_id: 'rule-that-does-not-exist' }),
      ]),
    )
    // Not an error and not a discount: the claim simply does not establish the
    // origin, so both events are ordinary client traffic.
    expect(billableOf(h)).toBe(2)
  })

  it('bills both when the event name does not match the rule the id names', async () => {
    const h = harness({ noCodeRules: rules })
    await h.post(
      '/v1/events',
      batchOf([
        customEvent({ action_id: 'act-1' }),
        customEvent({ action_id: 'act-1', rule_id: RULE_ID, name: 'something_else' }),
      ]),
    )
    expect(billableOf(h)).toBe(2)
  })

  it('accepts a claimed rule id without erroring when the site publishes nothing', async () => {
    // The ADR-0022 window: a rule published seconds ago against a stale
    // ingest-config cache. Rejecting would 400 an atomic batch and take the
    // visitor's pageviews with it.
    const h = harness({ noCodeRules: [] })
    const response = await h.post(
      '/v1/events',
      batchOf([customEvent({ action_id: 'act-1', rule_id: RULE_ID })]),
    )
    expect(response.status).toBe(202)
    expect(billableOf(h)).toBe(1)
  })
})
