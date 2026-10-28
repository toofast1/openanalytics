import { ApiError, timezoneSchema, utcInstantSchema } from '@openanalytics/contracts'
import {
  DEFAULT_ANALYTICS_QUERY_CONFIG,
  FILTER_DIMENSIONS,
  FILTER_OPERATORS,
  MAX_FILTER_CLAUSES,
  MAX_FILTER_VALUES,
  MAX_FILTER_VALUE_LENGTH,
  filterValuesFor,
  isUtcDayAligned,
  isUtcMinuteAligned,
  isUtcQuarterAligned,
  type AnalyticsFilter,
  type RollupResolution,
} from '@openanalytics/domain'
import { z } from 'zod'
import type { QueryParameterValue } from './clickhouse.ts'

/**
 * Allowlisted operation registry (docs snapshot 05, D-208; plan Milestone 7
 * items 1, 4 and 7).
 *
 * The gateway accepts an operation ID with typed parameters, never SQL, never a
 * table name, never a free-form filter. The shape enforces that structurally
 * rather than by convention:
 *
 * - `sql` is a **constant string** fixed at module load — assembled from literal
 *   table/dimension/measure lists in the factories below, never from a request
 *   value. A builder that took parameters could concatenate them; one that
 *   cannot see them cannot. Every value reaches ClickHouse through a
 *   `{name:Type}` placeholder.
 * - `bind` maps validated parameters onto those placeholder names, and the bound
 *   key set is cross-checked against the placeholders present in `sql`, so a
 *   renamed placeholder fails loudly at load time instead of binding nothing.
 * - An unregistered ID is rejected by `findOperation` before any connection is
 *   opened, so an unknown operation never reaches ClickHouse at all.
 *
 * Every analytics operation reads a **rollup** table only. None reads
 * `events_raw` — the plan's acceptance criterion is literally "overview/pages/
 * source queries do not GROUP BY raw events" (docs snapshot 04, Milestone 7),
 * and §15 forbids the raw table for overview/pages/sources/geo/devices/charts.
 * Unique visitors are read with `uniqMerge` (never a sum of `uniq` states) and
 * percentiles with `quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)`, whose
 * parameter list must match the stored `AggregateFunction` column type
 * (migration 0012).
 *
 * Every analytics operation binds `site_id` — or, since ADR-0080, the explicit
 * `site_ids` list a single screen reads its whole account through — and requires
 * site scope, so the registry is also the boundary that makes a cross-site read
 * impossible: there is no operation that omits the site filter, and the api
 * passes only ids the caller is already a member of.
 */

const CONFIG = DEFAULT_ANALYTICS_QUERY_CONFIG
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

const MAX_SPAN_MINUTE_MS = CONFIG.MAX_SPAN_MINUTE_HOURS * MS_PER_HOUR
const MAX_SPAN_HOUR_MS = CONFIG.MAX_SPAN_HOUR_DAYS * MS_PER_DAY
const MAX_SPAN_DAY_MS = CONFIG.MAX_SPAN_DAY_DAYS * MS_PER_DAY

/** Bounds on a top-N report's row count. */
const TOP_N_DEFAULT = 100
const TOP_N_MAX = 500

const PLACEHOLDER = /\{(\w+):[^}]+\}/g

export interface QueryOperation {
  readonly id: string
  readonly summary: string
  /**
   * Whether the operation may only be executed against a single site.
   *
   * Site scope is not advisory: a scoped operation must bind `site_id`, and that
   * is asserted at definition time. Docs snapshot 01 §3.4 — cross-site leakage
   * in legacy came from a filter that was merely *usually* applied.
   */
  readonly requiresSiteScope: boolean
  readonly sql: string
  /** Upper bound on rows this operation may return, independent of the query. */
  readonly maxRows: number
  /**
   * Whether the result may be served from the bounded query cache. A watermark
   * or liveness probe must always hit ClickHouse; a bucketed read may not.
   */
  readonly cacheable: boolean
  /**
   * Which cache TTL band this operation's result lives in. `'default'` is the
   * short TTL every rollup read gets, because a recent bucket is still filling.
   * `'finalized'` is the long TTL for a read the API has already proven is over a
   * finalized session range (the ADR-0011 refinement: a longer TTL for
   * provably-finalized ranges once the response carries a finalized watermark).
   */
  readonly cacheProfile: 'default' | 'finalized'
  /** Validates untrusted input and produces the ClickHouse parameter map. */
  bindParams(input: unknown): Readonly<Record<string, QueryParameterValue>>
}

function placeholdersOf(sql: string): Set<string> {
  return new Set(Array.from(sql.matchAll(PLACEHOLDER), (match) => match[1] as string))
}

function defineOperation<TSchema extends z.ZodType>(definition: {
  id: string
  summary: string
  requiresSiteScope: boolean
  params: TSchema
  sql: string
  maxRows: number
  cacheable?: boolean
  cacheProfile?: 'default' | 'finalized'
  /**
   * Whether this operation is permitted to read `events_raw`. False for the whole
   * additive analytics family — overview/pages/sources/geo/devices/charts must
   * read a rollup only (docs snapshot 02 §15). True for the funnel operation,
   * which §15 explicitly computes over the event facts with a bounded query, cache
   * and timeout ("dynamic funnels are computed over the session/event facts").
   */
  allowRawEvents?: boolean
  bind: (params: z.infer<TSchema>) => Record<string, QueryParameterValue>
}): QueryOperation {
  const placeholders = placeholdersOf(definition.sql)

  // Definition-time assertions. These run at module load, so a malformed
  // operation fails the process at startup and every test run, not on the first
  // request that happens to use it.
  if (/;|--|\/\*/.test(definition.sql)) {
    throw new Error(`operation "${definition.id}" sql must be a single statement without comments`)
  }
  // Site scope is "names its sites", not "names one site" (ADR-0080). The site
  // card operations bind `{site_ids:Array(UUID)}` because one screen reads the
  // whole account; either placeholder satisfies the boundary, because the
  // boundary is that the api decides the id set and the statement cannot widen
  // it. An operation binding neither could read every site in the cluster, which
  // is what this assertion has always existed to make impossible.
  if (
    definition.requiresSiteScope &&
    !placeholders.has('site_id') &&
    !placeholders.has('site_ids')
  ) {
    throw new Error(
      `operation "${definition.id}" is site-scoped but never binds {site_id:...} or {site_ids:...}`,
    )
  }
  // No analytics operation may read the raw event table (docs snapshot 02 §15,
  // plan Milestone 7 acceptance criterion). Asserted structurally so a future
  // edit that points an operation at events_raw fails at load, not in review. The
  // funnel operation opts in explicitly (allowRawEvents), because §15 computes
  // funnels over the event facts under a bounded, site-scoped, capped query.
  if (!definition.allowRawEvents && /\bevents_raw\b/i.test(definition.sql)) {
    throw new Error(`operation "${definition.id}" reads events_raw; rollup operations must not`)
  }

  return {
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: definition.requiresSiteScope,
    sql: definition.sql,
    maxRows: definition.maxRows,
    cacheable: definition.cacheable ?? true,
    cacheProfile: definition.cacheProfile ?? 'default',
    bindParams(input: unknown) {
      const parsed = definition.params.safeParse(input ?? {})
      if (!parsed.success) {
        throw new ApiError('VALIDATION_FAILED', 'Operation parameters are invalid', {
          details: {
            operation: definition.id,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.') || '(root)',
              message: issue.message,
            })),
          },
        })
      }

      const bound = definition.bind(parsed.data as z.infer<TSchema>)
      const boundKeys = new Set(Object.keys(bound))

      // Both directions: an unbound placeholder is a ClickHouse error at
      // execution time, and an extra bound value means the operation thinks it
      // is filtering by something the SQL ignores — the more dangerous of the two.
      for (const name of placeholders) {
        if (!boundKeys.has(name)) {
          throw new Error(`operation "${definition.id}" left placeholder {${name}} unbound`)
        }
      }
      for (const name of boundKeys) {
        if (!placeholders.has(name)) {
          throw new Error(`operation "${definition.id}" bound unused parameter "${name}"`)
        }
      }

      return bound
    },
  }
}

// ---------------------------------------------------------------------------
// Shared parameter shapes
// ---------------------------------------------------------------------------

/**
 * UTC-bucket boundary alignment the range must satisfy for its source rollup.
 *
 * `quarter` — the fifteen-minute atom (ADR-0079) — replaced `hour` in step 3,
 * because every read that used to be routed to an hour table is now routed to
 * its `*_15m` twin and its range is snapped a quarter-hour at a time. It is the
 * looser of the two: every UTC-hour boundary is also a quarter-hour boundary, so
 * nothing a caller could send before is refused now.
 */
type RangeAlignment = 'minute' | 'quarter' | 'day'

/** What the refusal message calls each boundary. */
const ALIGNMENT_LABEL: Record<RangeAlignment, string> = {
  minute: 'minute',
  quarter: 'quarter-hour',
  day: 'day',
}

function isAligned(alignment: RangeAlignment, instant: string): boolean {
  switch (alignment) {
    case 'minute':
      return isUtcMinuteAligned(instant)
    case 'quarter':
      return isUtcQuarterAligned(instant)
    case 'day':
      return isUtcDayAligned(instant)
  }
}

interface RangeParamsOptions {
  /** Longest span this operation's source rollup may scan. */
  readonly maxRangeMs: number
  /** Boundary the half-open range endpoints must land on. */
  readonly alignment: RangeAlignment
  readonly withTimezone: boolean
  readonly withLimit: boolean
  /**
   * How this operation participates in the import partition (ADR-0032, D2b/D4).
   *
   * `'cutover'` is the live breakdowns: they only need to know where live data
   * starts, because their imported rows arrive through a separate operation and
   * are merged in the api. `'full'` is everything that actually reads a staged
   * row and therefore has to name the run the pointer published.
   */
  readonly withImport?: false | 'cutover' | 'full'
}

/** `YYYY-MM-DD`, the wire form of the cutover (ADR-0032, D4). */
const cutoverDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * Builds the typed parameter schema for a range operation.
 *
 * The endpoint-alignment refinement is the structural guard behind the rollup
 * choice: a quarter operation reads UTC quarter-hour buckets, so a range whose
 * endpoints are not quarter-hour boundaries is rejected here rather than
 * answered with misattributed buckets. A day operation likewise refuses anything
 * but a UTC-midnight boundary, which is why it is only ever routed a UTC request
 * (`chooseResolution` composes non-UTC days from the atom operation instead).
 */
function rangeParamsSchema(options: RangeParamsOptions) {
  const shape: Record<string, z.ZodTypeAny> = {
    site_id: z.uuid(),
    from: utcInstantSchema,
    to: utcInstantSchema,
  }
  if (options.withTimezone) shape['timezone'] = timezoneSchema
  if (options.withLimit) {
    shape['limit'] = z.number().int().min(1).max(TOP_N_MAX).default(TOP_N_DEFAULT)
  }
  if (options.withImport === 'cutover' || options.withImport === 'full') {
    // Required, not optional, and that is the whole safety of the design: a
    // caller that forgot them cannot get a read that silently ignores the
    // cutover partition. "No import published" is expressed by *values* — the
    // nil UUID and the epoch sentinel — never by omission.
    shape['import_cutover'] = cutoverDateSchema
    if (options.withImport === 'full') shape['import_run_id'] = z.uuid()
  }

  return z
    .strictObject(shape)
    .superRefine((value: Record<string, unknown>, ctx: z.RefinementCtx) => {
      const from = value['from'] as string
      const to = value['to'] as string
      const fromMs = Date.parse(from)
      const toMs = Date.parse(to)

      if (fromMs >= toMs) {
        ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
        return
      }
      if (toMs - fromMs > options.maxRangeMs) {
        ctx.addIssue({
          code: 'custom',
          message: `range span exceeds this operation's ${options.maxRangeMs}ms maximum`,
        })
      }
      if (!isAligned(options.alignment, from) || !isAligned(options.alignment, to)) {
        ctx.addIssue({
          code: 'custom',
          message: `range endpoints must align to a UTC ${ALIGNMENT_LABEL[options.alignment]} boundary`,
        })
      }
    })
}

/** `2026-07-01T00:00:00.000Z` → `2026-07-01 00:00:00.000` (the DateTime64 form). */
function toClickHouseInstant(instant: string): string {
  return new Date(instant).toISOString().replace('T', ' ').replace('Z', '')
}

// Column references are qualified through the `t` table alias everywhere a
// SELECT alias shares a source column's name. `sum(events) AS events` shadows
// the column, so a later bare `events` — `sumIf(events, …)` — resolves to the
// alias and nests one aggregate inside another: ILLEGAL_AGGREGATION (found by
// this suite's first CI run against ClickHouse 26.3). `t.events` always names
// the column.
const RANGE_FILTER = [
  'WHERE t.site_id = {site_id:UUID}',
  "  AND t.bucket_start >= toDateTime64({from:String}, 3, 'UTC')",
  "  AND t.bucket_start < toDateTime64({to:String}, 3, 'UTC')",
].join('\n')

/**
 * Renders a timezone-local bucket expression as a UTC instant.
 *
 * Every stored bucket column is `DateTime('UTC')` or `DateTime64(3, 'UTC')`, and
 * ClickHouse renders a DateTime in the timezone carried by its *type*. A
 * `toStartOf*(col, {tz:String})` call picks the correct instant — the start of
 * the local minute/hour/day — but the value it returns is typed in `tz`, so it
 * serializes as that zone's wall clock with no offset attached to say so. The
 * API reads a bucket string as a UTC instant (it appends "Z"), which turned a
 * +03:00 zone's buckets into instants three hours in the future: buckets past
 * the end of the requested half-open range, an empty "yesterday" and hours that
 * have not happened yet.
 *
 * `toDateTime64(…, 3, 'UTC')` changes the rendering timezone and nothing else —
 * it is the same instant, printed as UTC wall clock. The local grouping is
 * unaffected: `toStartOf*` has already decided which rows share a bucket, and
 * relabelling the group key cannot move a row between groups. DST-correct 23h and
 * 25h local days are therefore still exactly as `toStartOfDay(col, tz)` grouped
 * them; only the name of each day changes, from local midnight to the UTC instant
 * that local midnight *is*.
 *
 * Non-timezone bucket expressions read a UTC column straight through and need no
 * wrapper — wrapping them would only change their wire format for no reason.
 */
function bucketUtc(expression: string): string {
  return `toDateTime64(${expression}, 3, 'UTC')`
}

// ---------------------------------------------------------------------------
// The imported side (ADR-0032, D2/D2b/D4)
// ---------------------------------------------------------------------------

/**
 * Where a provider's calendar day sits on the timeline.
 *
 * An aggregate-only export has one row per calendar day and no finer grain, so a
 * staged day has to be *placed* somewhere before it can be bucketed or filtered
 * beside live data. It is placed at the start of that calendar day **in the
 * request's timezone**, which is the only placement under which an imported day
 * and the live day it continues carry the same label: a viewer in Berlin sees
 * "2024-03-01" begin at 23:00Z on both sides of the cutover.
 *
 * **Every surface places a provider day the same way**, and that uniformity is
 * the correctness property rather than a tidiness one. When the chart placed a
 * day in the request's zone while the range totals and the breakdowns placed it
 * at UTC midnight, the three disagreed about which days a range contains: for a
 * viewer west of UTC a whole provider day fell outside the totals' window while
 * the chart showed it, and for a viewer east of UTC the seam day was counted on
 * both sides. A KPI card that does not equal the sum of its own chart is the
 * symptom, and it is the kind nobody reports as a bug.
 *
 * The two UTC-bucketed charts still pass `'UTC'` — they are only ever routed a
 * UTC request, so the zone *is* UTC there.
 */
function importedDayInstant(zone: string): string {
  return bucketUtc(`toDateTime(i.date, ${zone})`)
}

/**
 * The instant the live branch opens at (D4's read rule).
 *
 * The cutover is a calendar *date* and the live filter is over instants, so it is
 * rendered the same way an imported day is — the start of that date in the
 * request's zone. The two together are a strict partition: nothing before the
 * boundary comes from live, nothing at or after it comes from the import.
 *
 * `{import_cutover:Date}` is bound, never spliced, and a site with no published
 * import binds the epoch sentinel, which no bucket can precede.
 *
 * The `bucketUtc` wrapper is inert here — this value is compared, never selected,
 * and a comparison is between instants regardless of either side's rendering
 * timezone. It is kept so the boundary is written exactly like the bucket
 * expression it has to agree with.
 */
function cutoverBoundary(zone: string): string {
  return bucketUtc(`toDateTime({import_cutover:Date}, ${zone})`)
}

/** The imported branch's own WHERE: the run the pointer names, the cutover
 * partition, and the requested range applied to the placed day. */
function importedFilter(table: string, zone: string): string {
  const placed = importedDayInstant(zone)
  return [
    `FROM ${table} AS i`,
    'WHERE i.site_id = {site_id:UUID}',
    '  AND i.import_run_id = {import_run_id:UUID}',
    '  AND i.date < {import_cutover:Date}',
    `  AND ${placed} >= toDateTime64({from:String}, 3, 'UTC')`,
    `  AND ${placed} <  toDateTime64({to:String}, 3, 'UTC')`,
  ].join('\n')
}

const maxRangeFor: Record<RollupResolution, number> = {
  '1m': MAX_SPAN_MINUTE_MS,
  '15m': MAX_SPAN_HOUR_MS,
  '1d': MAX_SPAN_DAY_MS,
}

// ---------------------------------------------------------------------------
// Timeseries operations (the metrics chart: events, pageviews, visitors / time)
// ---------------------------------------------------------------------------

/** Indents a block by two spaces, so a branch reads the same inside a subquery
 * as it does at the top level. */
function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function defineTimeseries(definition: {
  id: string
  table: string
  source: RollupResolution
  /**
   * Group key. `bucket_start` reads pre-bucketed rows; a `toStartOf*` call
   * re-buckets to a timezone-local grain. Must be a constant expression.
   *
   * A timezone-local re-bucketing must come back as a UTC instant, so it is
   * wrapped in `toDateTime64(…, 3, 'UTC')` — see `bucketUtc` above.
   */
  bucketExpr: string
  /**
   * The same grouping applied to a staged provider day (ADR-0032, D2b). Present
   * only on the day and week operations: minute and hour grains have no imported
   * branch at all, because an aggregate-only export has no sub-day grain and a
   * fabricated hourly split would be a number nobody measured. Absent here means
   * the operation is live-only and its SQL is byte-identical to CP2's.
   */
  importedBucketExpr?: string
  alignment: RangeAlignment
  withTimezone: boolean
  maxRows: number
  summary: string
}): QueryOperation {
  const zone = definition.withTimezone ? '{tz:String}' : "'UTC'"
  const imported = definition.importedBucketExpr

  const liveBranch = [
    'SELECT',
    `  ${definition.bucketExpr} AS bucket,`,
    '  sum(t.events) AS events,',
    "  sumIf(t.events, t.event_type = 'page_view') AS pageviews,",
    // The merge is filtered to the same population `pageviews` counts — the
    // contract sentence this implements is `OverviewTotals.visitors` in
    // openapi.yaml (ADR-0036): a bucket's visitors are the distinct anonymous
    // ids with at least one page view IN THAT BUCKET, so visitors <= pageviews
    // on every point. A bare `uniqMerge` also counted the states under every
    // other event_type, where a departure beacon landing in the next bucket
    // made a "visitor" with zero pageviews, and where the identify-typed state
    // holds the user_id half of an identified person the page_view state
    // already counts as their anonymous id.
    "  uniqMergeIf(t.visitors, t.event_type = 'page_view') AS visitors",
    `FROM ${definition.table} AS t`,
    RANGE_FILTER,
    // **Every timeseries takes the cutover, including the ones with no imported
    // branch.** A minute or hour chart cannot show imported data honestly — an
    // aggregate-only export has no sub-day grain — but it must not show live data
    // the day chart is hiding either: two charts of the same range disagreeing
    // about whether the pre-cutover days exist is worse than one of them being
    // empty, and the empty one is at least explained by `estimated`.
    `  AND t.bucket_start >= ${cutoverBoundary(zone)}`,
    'GROUP BY bucket',
  ].join('\n')

  const sql =
    imported === undefined
      ? [liveBranch, 'ORDER BY bucket'].join('\n')
      : [
          'SELECT',
          '  u.bucket AS bucket,',
          '  sum(u.events) AS events,',
          '  sum(u.pageviews) AS pageviews,',
          // **Not `uniqMerge`, and it cannot be.** The live branch has already
          // merged its states into a count and the imported branch never had a
          // state to merge — an aggregate-only provider ships a daily visitor
          // number and explicitly refuses to add its own days together. Adding
          // them is therefore the only arithmetic available across the seam, and
          // saying so is what D5's `estimated` is for; the alternative would be a
          // `uniqState` conjured out of a count, which is a fabricated identity
          // set rather than an approximation.
          '  sum(u.visitors) AS visitors',
          'FROM (',
          indent(liveBranch),
          '  UNION ALL',
          indent(
            [
              'SELECT',
              `  ${imported} AS bucket,`,
              // An aggregate-only export counts page views and nothing else in
              // its daily totals, so `events` is the pageview count rather than a
              // total this provider never measured. Custom-event counts live in
              // their own report and are read through the breakdown path — which
              // makes `events` the one measure here that is *not* a provider row
              // unmodified, and D5's `provider_defined` claim excludes it.
              '  toUInt64(sum(i.pageviews)) AS events,',
              '  toUInt64(sum(i.pageviews)) AS pageviews,',
              '  toUInt64(sum(i.visitors)) AS visitors',
              importedFilter('imported_metrics_1d', zone),
              'GROUP BY bucket',
            ].join('\n'),
          ),
          ') AS u',
          'GROUP BY bucket',
          'ORDER BY bucket',
        ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      withTimezone: definition.withTimezone,
      withLimit: false,
      withImport: imported === undefined ? 'cutover' : 'full',
    }),
    sql,
    maxRows: definition.maxRows,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      ...(definition.withTimezone ? { tz: params['timezone'] as string } : {}),
      import_cutover: params['import_cutover'] as string,
      ...(imported === undefined ? {} : { import_run_id: params['import_run_id'] as string }),
    }),
  })
}

const timeseriesOperations: readonly QueryOperation[] = [
  defineTimeseries({
    id: 'analytics.timeseries_minute',
    summary: 'Events, pageviews and unique visitors per timezone-local minute (metrics_1m).',
    table: 'metrics_1m',
    source: '1m',
    bucketExpr: bucketUtc('toStartOfMinute(t.bucket_start, {tz:String})'),
    alignment: 'minute',
    withTimezone: true,
    maxRows: 3_000,
  }),
  defineTimeseries({
    id: 'analytics.timeseries_hour',
    summary: 'Events, pageviews and unique visitors per timezone-local hour (metrics_15m).',
    table: 'metrics_15m',
    source: '15m',
    bucketExpr: bucketUtc('toStartOfHour(t.bucket_start, {tz:String})'),
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 1_000,
  }),
  defineTimeseries({
    id: 'analytics.timeseries_day',
    summary:
      'Events, pageviews and unique visitors per timezone-local day, composed from metrics_15m so DST 23/25h days are correct, unioned with the published import before the cutover.',
    table: 'metrics_15m',
    source: '15m',
    bucketExpr: bucketUtc('toStartOfDay(t.bucket_start, {tz:String})'),
    // A provider day *is* a local day, so the placement is the whole bucketing:
    // no re-grouping, just the same label the live side computes.
    importedBucketExpr: importedDayInstant('{tz:String}'),
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 500,
  }),
  defineTimeseries({
    id: 'analytics.timeseries_day_utc',
    summary:
      'Events, pageviews and unique visitors per UTC day, read straight from metrics_1d and unioned with the published import before the cutover.',
    table: 'metrics_1d',
    source: '1d',
    bucketExpr: 't.bucket_start',
    // Deliberately **not** `bucketUtc(…)`, unlike every timezone-local bucket:
    // the live side of this union selects the raw `DateTime('UTC')` column, and a
    // `DateTime64(3, 'UTC')` branch beside it would widen the union's supertype
    // and start rendering every bucket of every live-only site with a
    // milliseconds suffix. Same instant, different bytes on the wire — and this
    // operation's whole contract with CP2 is that a site with no import reads
    // byte-identically.
    importedBucketExpr: "toDateTime(i.date, 'UTC')",
    alignment: 'day',
    withTimezone: false,
    maxRows: 4_000,
  }),
  // ISO weeks (CP3). There is no week rollup and there should not be one: a week
  // begins on the *request timezone's* Monday, so a stored UTC-week bucket would
  // be the wrong seven days for every zone but UTC. Both operations therefore
  // group at read time, and both take unique visitors from `uniqMerge` over the
  // whole week — a week's visitors are emphatically not the sum of its days'.
  defineTimeseries({
    id: 'analytics.timeseries_week_utc',
    summary:
      'Events, pageviews and unique visitors per ISO week (Monday start) in UTC, grouped over metrics_1d.',
    table: 'metrics_1d',
    source: '1d',
    // Mode 1 is the ISO reading of `toStartOfWeek`: weeks begin on Monday. The
    // call returns a `Date` (the Monday), and `toDateTime64(Date, 3, 'UTC')`
    // reads that date's midnight in UTC — which for a UTC week *is* the week's
    // start instant. Not a `bucketUtc` case: there is no zone-typed value to
    // relabel here, the wrapper is doing the Date → instant widening itself.
    bucketExpr: "toDateTime64(toStartOfWeek(t.bucket_start, 1), 3, 'UTC')",
    // `toStartOfWeek` over a `Date` returns the Monday as a Date, which
    // `toDateTime64(…, 3, 'UTC')` reads as that date's UTC midnight — the same
    // instant, computed the same way, as the live branch above.
    importedBucketExpr: "toDateTime64(toStartOfWeek(i.date, 1), 3, 'UTC')",
    alignment: 'day',
    withTimezone: false,
    maxRows: 600,
  }),
  defineTimeseries({
    id: 'analytics.timeseries_week',
    summary:
      'Events, pageviews and unique visitors per timezone-local ISO week (Monday start), composed from metrics_15m.',
    table: 'metrics_15m',
    source: '15m',
    // Three steps, each undoing an ambiguity the previous one leaves:
    //   toStartOfWeek(col, 1, tz) → the local Monday, as a `Date` — a calendar
    //     date with no instant attached, so it cannot be a bucket label yet.
    //   toDateTime(date, tz)      → that date's midnight *in tz*: the instant
    //     the local week actually starts at (03:00Z behind UTC, 21:00Z of the
    //     previous Sunday ahead of it).
    //   bucketUtc(…)              → renders that instant as UTC wall clock, the
    //     CP1 rule every timezone-local bucket obeys.
    bucketExpr: bucketUtc('toDateTime(toStartOfWeek(t.bucket_start, 1, {tz:String}), {tz:String})'),
    // The provider day belongs to the ISO week of its own calendar date, and the
    // label is that Monday's local midnight — exactly as on the live side.
    //
    // **`toStartOfWeek` takes no timezone here, and must not.** The live branch
    // passes one because its argument is a `DateTime` that has to be reduced to a
    // local calendar date first. `i.date` is already a `Date`, and ClickHouse
    // rejects a timezone argument on a Date-typed call of the `toStartOf*` family
    // with ILLEGAL_TYPE_OF_ARGUMENT (43) rather than ignoring it. It would be
    // meaningless anyway: no zone can move a calendar date into a different ISO
    // week. The zone belongs on the `toDateTime` that turns the resulting Monday
    // back into an instant, which is where it is.
    importedBucketExpr: bucketUtc('toDateTime(toStartOfWeek(i.date, 1), {tz:String})'),
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 600,
  }),
]

// ---------------------------------------------------------------------------
// Overview totals (single-row summary of the metrics family over a range)
// ---------------------------------------------------------------------------

/**
 * Range totals, live plus the published import (ADR-0032, D2b).
 *
 * A total has no bucket to label, and it still takes the request's timezone —
 * because the *window* it sums over has to contain the same provider days the
 * chart of that window plots. Placing a day at UTC midnight here while the chart
 * placed it at local midnight made the KPI card disagree with the chart beneath
 * it by a whole day for any viewer far enough from UTC.
 */
function defineOverview(definition: {
  id: string
  table: string
  source: RollupResolution
  alignment: RangeAlignment
  summary: string
}): QueryOperation {
  const liveBranch = [
    'SELECT',
    '  sum(t.events) AS events,',
    "  sumIf(t.events, t.event_type = 'page_view') AS pageviews,",
    '  sum(t.billable_events) AS billable_events,',
    // Same filter and same reason as the timeseries live branch above: the
    // `OverviewTotals.visitors` contract sentence (ADR-0036) — the range's
    // visitors are the distinct anonymous ids with at least one page view in
    // it, the population `pageviews` already counts.
    "  uniqMergeIf(t.visitors, t.event_type = 'page_view') AS visitors",
    `FROM ${definition.table} AS t`,
    RANGE_FILTER,
    `  AND t.bucket_start >= ${cutoverBoundary('{tz:String}')}`,
  ].join('\n')

  const sql = [
    'SELECT',
    // `events` is the provider's pageview count and nothing else — an
    // aggregate-only export measures no other event class in its daily totals.
    // That is the one measure here a fully-imported range cannot claim as the
    // provider's own unmodified number, and D5's `provider_defined` is scoped
    // accordingly.
    '  sum(u.events) AS events,',
    '  sum(u.pageviews) AS pageviews,',
    '  sum(u.billable_events) AS billable_events,',
    '  sum(u.visitors) AS visitors',
    'FROM (',
    indent(liveBranch),
    '  UNION ALL',
    indent(
      [
        'SELECT',
        '  toUInt64(sum(i.pageviews)) AS events,',
        '  toUInt64(sum(i.pageviews)) AS pageviews,',
        // Zero, and it is a decision rather than a placeholder: provider import
        // data is not billable (ADR-0032 D10, D-101), there is no code path from
        // the import pipeline to the usage ledger, and a range total that added
        // imported rows into `billable_events` would make a customer's dashboard
        // disagree with their invoice.
        '  toUInt64(0) AS billable_events,',
        '  toUInt64(sum(i.visitors)) AS visitors',
        importedFilter('imported_metrics_1d', '{tz:String}'),
      ].join('\n'),
    ),
    ') AS u',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      withTimezone: true,
      withLimit: false,
      withImport: 'full',
    }),
    sql,
    maxRows: 1,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      tz: params['timezone'] as string,
      import_run_id: params['import_run_id'] as string,
      import_cutover: params['import_cutover'] as string,
    }),
  })
}

const overviewOperations: readonly QueryOperation[] = [
  defineOverview({
    id: 'analytics.overview_hour',
    summary:
      'Range totals — events, pageviews, billable events, unique visitors (metrics_15m plus the published import).',
    table: 'metrics_15m',
    source: '15m',
    alignment: 'quarter',
  }),
  defineOverview({
    id: 'analytics.overview_day',
    summary:
      'Range totals over UTC days — events, pageviews, billable events, visitors (metrics_1d plus the published import).',
    table: 'metrics_1d',
    source: '1d',
    alignment: 'day',
  }),
]

// ---------------------------------------------------------------------------
// Top-N reports (pages, sources, geography, devices, custom events, performance)
// ---------------------------------------------------------------------------

function defineReport(definition: {
  id: string
  table: string
  source: RollupResolution
  alignment: RangeAlignment
  dimensions: readonly string[]
  measures: readonly string[]
  orderBy: string
  /**
   * Whether this report has an imported counterpart the api merges in
   * (ADR-0032, D2b).
   *
   * When it does, the **live** side gains D4's other half — `bucket >= cutover` —
   * and nothing else: the imported rows arrive through their own operation and
   * are merged in the api, never unioned here. Without the filter a customer who
   * publishes with a cutover of `first live day + 1` (the one choice the review
   * step allows past the default) would see that day counted twice: once from the
   * provider and once from their own tracker. The chart already partitions;
   * a pages table that did not would disagree with it.
   *
   * `performance` is the one report with no imported counterpart, and it is
   * deliberately left alone: applying the partition there could only *hide* live
   * web vitals, with no imported rows to put in their place.
   */
  withImport: boolean
  summary: string
}): QueryOperation {
  const selectList = [...definition.dimensions, ...definition.measures]
  const sql = [
    'SELECT',
    selectList
      .map((column, index) => `  ${column}${index === selectList.length - 1 ? '' : ','}`)
      .join('\n'),
    `FROM ${definition.table} AS t`,
    RANGE_FILTER,
    ...(definition.withImport ? [`  AND t.bucket_start >= ${cutoverBoundary('{tz:String}')}`] : []),
    `GROUP BY ${definition.dimensions.join(', ')}`,
    `ORDER BY ${definition.orderBy} DESC`,
    'LIMIT {limit:UInt32}',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      // The zone reaches this statement only through the cutover boundary, which
      // has to be the same instant the chart and the totals opened their live
      // branch at — otherwise a table and the chart above it disagree about which
      // days are the provider's.
      withTimezone: definition.withImport,
      withLimit: true,
      withImport: definition.withImport ? 'cutover' : false,
    }),
    sql,
    maxRows: TOP_N_MAX,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      limit: params['limit'] as number,
      // The cutover only: there is no imported table in this statement, so a run
      // id here would be a bound value the SQL never uses — which the definition
      // checker rejects, deliberately, as the shape a silently dropped filter
      // takes.
      ...(definition.withImport
        ? {
            tz: params['timezone'] as string,
            import_cutover: params['import_cutover'] as string,
          }
        : {}),
    }),
  })
}

interface ReportShape {
  readonly slug: string
  readonly hourTable: string
  readonly dayTable: string
  readonly dimensions: readonly string[]
  readonly measures: readonly string[]
  readonly orderBy: string
  /** True when an `analytics.imported_<slug>` operation exists to merge with. */
  readonly imported: boolean
  readonly summary: string
}

const REPORT_SHAPES: readonly ReportShape[] = [
  {
    slug: 'pages',
    imported: true,
    hourTable: 'pages_15m',
    dayTable: 'pages_1d',
    dimensions: ['page_path'],
    measures: ['sum(views) AS views', 'uniqMerge(visitors) AS visitors'],
    orderBy: 'views',
    summary: 'Top pages by views with unique visitors.',
  },
  {
    slug: 'sources',
    imported: true,
    hourTable: 'sources_15m',
    dayTable: 'sources_1d',
    dimensions: ['referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign'],
    measures: ['sum(views) AS views', 'uniqMerge(visitors) AS visitors'],
    orderBy: 'views',
    summary: 'Top acquisition sources (referrer domain and UTM tuple) by views.',
  },
  {
    slug: 'geography',
    imported: true,
    hourTable: 'geography_15m',
    dayTable: 'geography_1d',
    dimensions: ['country', 'city'],
    measures: ['sum(views) AS views', 'uniqMerge(visitors) AS visitors'],
    orderBy: 'views',
    summary: 'Top countries and cities by views with unique visitors.',
  },
  {
    slug: 'devices',
    imported: true,
    hourTable: 'devices_15m',
    dayTable: 'devices_1d',
    dimensions: ['device_type', 'browser', 'os'],
    measures: ['sum(views) AS views', 'uniqMerge(visitors) AS visitors'],
    orderBy: 'views',
    summary: 'Top device/browser/OS combinations by views.',
  },
  {
    slug: 'custom_events',
    imported: true,
    hourTable: 'custom_events_15m',
    dayTable: 'custom_events_1d',
    dimensions: ['event_name', 'event_type'],
    measures: [
      'sum(events) AS events',
      'sum(billable_events) AS billable_events',
      'uniqMerge(visitors) AS visitors',
    ],
    orderBy: 'events',
    summary: 'Top custom events and conversions by count.',
  },
  {
    slug: 'performance',
    imported: false,
    hourTable: 'performance_15m',
    dayTable: 'performance_1d',
    dimensions: ['metric', 'device_type'],
    measures: [
      'sum(samples) AS samples',
      'sum(value_sum) AS value_sum',
      'quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(value_quantiles) AS percentiles',
      'sum(good_samples) AS good_samples',
      'sum(needs_improvement_samples) AS needs_improvement_samples',
      'sum(poor_samples) AS poor_samples',
    ],
    orderBy: 'samples',
    summary: 'Web-vital percentiles (merged t-digest), mean and rating distribution per metric.',
  },
]

const reportOperations: readonly QueryOperation[] = REPORT_SHAPES.flatMap((shape) => [
  defineReport({
    id: `analytics.${shape.slug}_hour`,
    table: shape.hourTable,
    source: '15m',
    alignment: 'quarter',
    dimensions: shape.dimensions,
    measures: shape.measures,
    orderBy: shape.orderBy,
    withImport: shape.imported,
    summary: `${shape.summary} Hour rollup.`,
  }),
  defineReport({
    id: `analytics.${shape.slug}_day`,
    table: shape.dayTable,
    source: '1d',
    alignment: 'day',
    dimensions: shape.dimensions,
    measures: shape.measures,
    orderBy: shape.orderBy,
    withImport: shape.imported,
    summary: `${shape.summary} UTC-day rollup.`,
  }),
])

// ---------------------------------------------------------------------------
// What a custom-events row may say beyond a count (ADR-0038, D5; ClickHouse
// migration 0021).
//
// A **second operation**, not a widening of `analytics.custom_events_*`, and the
// api joins its rows onto the report's by `(event_name, event_type)` — beside
// the definition-label join that route already does. Two reasons it is separate:
// the counts operation is read by surfaces these fields have no business on
// (the public dashboard mounts its own narrow set and simply cannot call an
// operation it does not name), and a decoration that fails should degrade the
// decoration rather than the numbers.
//
// It carries no timezone and no import parameter, deliberately: the cutover
// partitions *counts* between a provider's days and ours, and an imported day
// has no event instant, no path and no properties to partition. Imported rows
// merge in with the three fields null, which is the same answer history gets.
// ---------------------------------------------------------------------------

function defineCustomEventSamples(definition: {
  id: string
  table: string
  source: RollupResolution
  alignment: RangeAlignment
  summary: string
}): QueryOperation {
  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      withTimezone: false,
      withLimit: true,
      withImport: false,
    }),
    // Every aggregated column is qualified through `t`. Each one here aliases
    // to its own source column's name — the shape RANGE_FILTER's comment above
    // records as the ILLEGAL_AGGREGATION trap, where a later bare reference
    // resolves to the alias and nests one aggregate inside another. The
    // unqualified form does answer on ClickHouse 26.3 (the migration suite ran
    // it green before this was tightened), so this is the file's convention
    // applied rather than a defect repaired — and the convention exists because
    // the failure it prevents was found in CI, not in review.
    sql: [
      'SELECT',
      '  t.event_name AS event_name,',
      '  t.event_type AS event_type,',
      // Summed and returned so the cut is inspectable, but never served: it
      // exists so this statement's top-N is the *same* top-N the counts
      // operation takes, from the same numbers over the same filter.
      '  sum(t.events) AS events,',
      '  max(t.last_seen_at) AS last_seen_at,',
      // argMaxMerge over the range: the page and the properties of the newest
      // event by its own `occurred_at`, not by insertion order.
      '  argMaxMerge(t.sample_page_path) AS sample_page_path,',
      '  argMaxMerge(t.sample_properties) AS sample_properties',
      `FROM ${definition.table} AS t`,
      RANGE_FILTER,
      'GROUP BY event_name, event_type',
      'ORDER BY events DESC',
      'LIMIT {limit:UInt32}',
    ].join('\n'),
    maxRows: TOP_N_MAX,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      limit: params['limit'] as number,
    }),
  })
}

const customEventSampleOperations: readonly QueryOperation[] = [
  defineCustomEventSamples({
    id: 'analytics.custom_event_samples_hour',
    table: 'custom_event_samples_15m',
    source: '15m',
    alignment: 'quarter',
    summary: 'Last-seen instant, page and properties per custom event. Hour rollup.',
  }),
  defineCustomEventSamples({
    id: 'analytics.custom_event_samples_day',
    table: 'custom_event_samples_1d',
    source: '1d',
    alignment: 'day',
    summary: 'Last-seen instant, page and properties per custom event. UTC-day rollup.',
  }),
]

// ---------------------------------------------------------------------------
// Imported-only breakdowns (ADR-0032, D2b).
//
// **Breakdowns do not union in SQL, and that is the decision, not an omission.**
// The live devices operation groups (device_type, browser, os) *jointly* while an
// aggregate-only export carries one of the three per file; the live geography
// operation groups (country, city) while the import has no city at all. A
// blank-padded UNION would therefore seat fabricated tuples — ('', 'Chrome', '')
// — beside real ones, in the same column, indistinguishable. So each report gets
// its own small operation here and the api merges the two lists, summing counts
// on equal keys and re-cutting the top N (see apps/api/src/analytics/service.ts).
//
// Every one of them projects the **live report's own column names**, because the
// merge is keyed on them and the response schema must not change: a caller
// cannot tell a merged page row from a live one, which is the point.
//
// The grouping is deliberately at the *response's* key rather than at the staged
// table's full sort key. `imported_pages_1d` carries (hostname, page) and the
// live pages report has no hostname dimension, so grouping by hostname here would
// make `LIMIT` cut a top-N of rows that the api then has to collapse anyway —
// and a path split across three hostnames could lose its place in the ranking to
// a path that is not. Summing to the response key first keeps the cut honest.
// The dropped dimensions (hostname, region, utm_content/term, link_url, path)
// stay in ClickHouse and travel out through the export, which is where they have
// a consumer.
// ---------------------------------------------------------------------------

function defineImportedReport(definition: {
  id: string
  table: string
  dimensions: readonly string[]
  measures: readonly string[]
  orderBy: string
  maxRows: number
  summary: string
}): QueryOperation {
  const selectList = [...definition.dimensions, ...definition.measures]
  const groupBy = definition.dimensions.map((column) => {
    const alias = / AS (\w+)$/.exec(column)?.[1]
    return alias ?? column
  })

  const sql = [
    'SELECT',
    selectList
      .map((column, index) => `  ${column}${index === selectList.length - 1 ? '' : ','}`)
      .join('\n'),
    importedFilter(definition.table, '{tz:String}'),
    `GROUP BY ${groupBy.join(', ')}`,
    `ORDER BY ${definition.orderBy} DESC`,
    'LIMIT {limit:UInt32}',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    params: rangeParamsSchema({
      // The api routes these beside an hour- or a day-rollup report, and a
      // day-aligned range is quarter-aligned too, so the looser boundary
      // accepts both — and it has to be the looser one, because the live report
      // beside it is routed a quarter-hour-snapped range (ADR-0079, step 3).
      maxRangeMs: MAX_SPAN_DAY_MS,
      alignment: 'quarter',
      // The same placement the live half of this report used. Two halves of one
      // merged list that disagreed about which days a range contains would be a
      // table whose rows come from different windows.
      withTimezone: true,
      withLimit: true,
      withImport: 'full',
    }),
    sql,
    maxRows: definition.maxRows,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      tz: params['timezone'] as string,
      import_run_id: params['import_run_id'] as string,
      import_cutover: params['import_cutover'] as string,
      limit: params['limit'] as number,
    }),
  })
}

/** Views and unique visitors, in the live reports' own column names. `views` is
 * the provider's pageview count: it is what the live `views` measure counts. */
const IMPORTED_VIEW_MEASURES = [
  'toUInt64(sum(i.pageviews)) AS views',
  'toUInt64(sum(i.visitors)) AS visitors',
]

const importedReportOperations: readonly QueryOperation[] = [
  defineImportedReport({
    id: 'analytics.imported_pages',
    summary: 'Top imported pages by views, summed across the export’s hostnames.',
    table: 'imported_pages_1d',
    dimensions: ['i.page AS page_path'],
    measures: IMPORTED_VIEW_MEASURES,
    orderBy: 'views',
    maxRows: TOP_N_MAX,
  }),
  defineImportedReport({
    id: 'analytics.imported_sources',
    // `referrer`, not `source`: the live dimension is the referring domain, and
    // an empty referrer means direct traffic on both sides. Plausible's `source`
    // is its own resolved channel name ("Google", "Direct / None") and has no
    // live counterpart to be merged onto.
    summary: 'Top imported acquisition sources (referrer domain and UTM triple) by views.',
    table: 'imported_sources_1d',
    dimensions: [
      'i.referrer AS referrer_domain',
      'i.utm_source AS utm_source',
      'i.utm_medium AS utm_medium',
      'i.utm_campaign AS utm_campaign',
    ],
    measures: IMPORTED_VIEW_MEASURES,
    orderBy: 'views',
    maxRows: TOP_N_MAX,
  }),
  defineImportedReport({
    id: 'analytics.imported_geography',
    // Country only. The staged table has a region column and the live report has
    // none, and there is no city at all (D2) — so the api pads `city` with the
    // empty string, which is exactly what a live row with an unresolved city
    // already carries. No city is ever invented.
    summary: 'Top imported countries by views. The import has no city dimension.',
    table: 'imported_geography_1d',
    dimensions: ['i.country AS country'],
    measures: IMPORTED_VIEW_MEASURES,
    orderBy: 'views',
    maxRows: TOP_N_MAX,
  }),
  defineImportedReport({
    id: 'analytics.imported_devices',
    summary: 'Top imported device classes by views.',
    table: 'imported_devices_1d',
    dimensions: ['i.device AS device_type'],
    measures: IMPORTED_VIEW_MEASURES,
    orderBy: 'views',
    maxRows: TOP_N_MAX,
  }),
  defineImportedReport({
    id: 'analytics.imported_browsers',
    summary: 'Top imported browsers and versions by views.',
    table: 'imported_browsers_1d',
    dimensions: ['i.browser AS browser', 'i.browser_version AS browser_version'],
    measures: IMPORTED_VIEW_MEASURES,
    orderBy: 'views',
    maxRows: TOP_N_MAX,
  }),
  defineImportedReport({
    id: 'analytics.imported_os',
    summary: 'Top imported operating systems and versions by views.',
    table: 'imported_os_1d',
    dimensions: ['i.operating_system AS os', 'i.os_version AS os_version'],
    measures: IMPORTED_VIEW_MEASURES,
    orderBy: 'views',
    maxRows: TOP_N_MAX,
  }),
  defineImportedReport({
    id: 'analytics.imported_custom_events',
    summary: 'Top imported custom events by occurrence count.',
    table: 'imported_custom_events_1d',
    dimensions: ['i.name AS event_name'],
    measures: ['toUInt64(sum(i.events)) AS events', 'toUInt64(sum(i.visitors)) AS visitors'],
    orderBy: 'events',
    maxRows: TOP_N_MAX,
  }),
]

// ---------------------------------------------------------------------------
// Session metrics (docs snapshot 02 §10, §15; plan Milestone 8 items 6-7;
// docs snapshot 05, D-211). Two layers, read as separate operations so the
// finalized layer earns the long cache TTL and the provisional layer stays
// short:
//
//   * Finalized layer — reads a session_rollups_* swap table. Current truth is
//     argMax(col, generation) per (site, bucket_start); the reader never uses
//     FINAL (migration 0014). The API only routes a bucket here once it is
//     provably before the site's finalized_through, so its answer never changes
//     and it is cached long (cacheProfile 'finalized').
//   * Provisional layer — reads session_facts_versions directly. Current truth is
//     argMax(col, version) per (site, session_id) THEN retracted = 0 — the
//     argMax-then-filter contract migration 0013 mandates, never a pre-filter,
//     never FINAL. Short TTL: these buckets are still revisable.
//
// Every measure is additive across buckets and across the layer merge; bounce
// rate and the average durations are derived at read from these totals, never
// stored (§10). Aggregated columns are qualified through the subquery alias so a
// SELECT alias that reuses a column name cannot nest one aggregate in another
// (the ClickHouse ILLEGAL_AGGREGATION trap).
// ---------------------------------------------------------------------------

const SESSION_MEASURE_SELECT_FINALIZED = [
  '  sum(cur.sessions) AS sessions,',
  '  sum(cur.engaged_sessions) AS engaged_sessions,',
  '  sum(cur.bounced_sessions) AS bounced_sessions,',
  '  sum(cur.pageviews) AS pageviews,',
  '  sum(cur.total_session_duration_ms) AS total_session_duration_ms,',
  '  sum(cur.total_active_duration_ms) AS total_active_duration_ms',
].join('\n')

function defineSessionFinalized(definition: {
  id: string
  table: string
  bucketExpr: string
  source: RollupResolution
  alignment: RangeAlignment
  withTimezone: boolean
  maxRows: number
  summary: string
}): QueryOperation {
  const sql = [
    'SELECT',
    `  ${definition.bucketExpr} AS bucket,`,
    SESSION_MEASURE_SELECT_FINALIZED,
    'FROM (',
    '  SELECT',
    '    sr.bucket_start AS bucket_start,',
    '    argMax(sr.sessions, sr.generation) AS sessions,',
    '    argMax(sr.engaged_sessions, sr.generation) AS engaged_sessions,',
    '    argMax(sr.bounced_sessions, sr.generation) AS bounced_sessions,',
    '    argMax(sr.pageviews, sr.generation) AS pageviews,',
    '    argMax(sr.total_session_duration_ms, sr.generation) AS total_session_duration_ms,',
    '    argMax(sr.total_active_duration_ms, sr.generation) AS total_active_duration_ms',
    `  FROM ${definition.table} AS sr`,
    '  WHERE sr.site_id = {site_id:UUID}',
    "    AND sr.bucket_start >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND sr.bucket_start <  toDateTime64({to:String}, 3, 'UTC')",
    '  GROUP BY sr.site_id, sr.bucket_start',
    ') AS cur',
    'GROUP BY bucket',
    'ORDER BY bucket',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    cacheProfile: 'finalized',
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      withTimezone: definition.withTimezone,
      withLimit: false,
    }),
    sql,
    maxRows: definition.maxRows,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      ...(definition.withTimezone ? { tz: params['timezone'] as string } : {}),
    }),
  })
}

const SESSION_MEASURE_SELECT_PROVISIONAL = [
  '  count() AS sessions,',
  '  countIf(cur.engaged = 1) AS engaged_sessions,',
  '  countIf(cur.engaged = 0) AS bounced_sessions,',
  '  sum(cur.pageviews) AS pageviews,',
  '  sum(cur.session_duration_ms) AS total_session_duration_ms,',
  '  sum(cur.active_duration_ms) AS total_active_duration_ms',
].join('\n')

function defineSessionProvisional(definition: {
  id: string
  bucketExpr: string
  source: RollupResolution
  alignment: RangeAlignment
  withTimezone: boolean
  maxRows: number
  summary: string
}): QueryOperation {
  const sql = [
    'SELECT',
    `  ${definition.bucketExpr} AS bucket,`,
    SESSION_MEASURE_SELECT_PROVISIONAL,
    'FROM (',
    '  SELECT',
    '    argMax(sfv.session_start, sfv.version) AS session_start,',
    '    argMax(sfv.engaged, sfv.version) AS engaged,',
    '    argMax(sfv.pageviews, sfv.version) AS pageviews,',
    '    argMax(sfv.session_duration_ms, sfv.version) AS session_duration_ms,',
    '    argMax(sfv.active_duration_ms, sfv.version) AS active_duration_ms,',
    '    argMax(sfv.retracted, sfv.version) AS retracted',
    '  FROM session_facts_versions AS sfv',
    '  WHERE sfv.site_id = {site_id:UUID}',
    "    AND sfv.session_start >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND sfv.session_start <  toDateTime64({to:String}, 3, 'UTC')",
    '  GROUP BY sfv.site_id, sfv.session_id',
    ') AS cur',
    'WHERE cur.retracted = 0',
    'GROUP BY bucket',
    'ORDER BY bucket',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    cacheProfile: 'default',
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      withTimezone: definition.withTimezone,
      withLimit: false,
    }),
    sql,
    maxRows: definition.maxRows,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      ...(definition.withTimezone ? { tz: params['timezone'] as string } : {}),
    }),
  })
}

const sessionOperations: readonly QueryOperation[] = [
  // Hour grain: local hours composed from the 15m layers, in any zone.
  defineSessionFinalized({
    id: 'analytics.sessions_finalized_hour',
    summary: 'Finalized session totals per timezone-local hour (session_rollups_15m).',
    table: 'session_rollups_15m',
    bucketExpr: bucketUtc('toStartOfHour(cur.bucket_start, {tz:String})'),
    source: '15m',
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 2_000,
  }),
  defineSessionProvisional({
    id: 'analytics.sessions_provisional_hour',
    summary: 'Provisional session totals per timezone-local hour (session_facts_versions).',
    bucketExpr: bucketUtc('toStartOfHour(cur.session_start, {tz:String})'),
    source: '15m',
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 2_000,
  }),
  // UTC day grain: read the 1d layers directly.
  defineSessionFinalized({
    id: 'analytics.sessions_finalized_day',
    summary: 'Finalized session totals per UTC day (session_rollups_1d).',
    table: 'session_rollups_1d',
    bucketExpr: 'cur.bucket_start',
    source: '1d',
    alignment: 'day',
    withTimezone: false,
    maxRows: 4_000,
  }),
  defineSessionProvisional({
    id: 'analytics.sessions_provisional_day',
    summary: 'Provisional session totals per UTC day (session_facts_versions).',
    bucketExpr: 'toStartOfDay(cur.session_start)',
    source: '1d',
    alignment: 'day',
    withTimezone: false,
    maxRows: 4_000,
  }),
  // Non-UTC day grain: compose local days from the 1h layers so DST 23/25h days
  // are correct, the same rule the additive day chart uses.
  defineSessionFinalized({
    id: 'analytics.sessions_finalized_day_local',
    summary: 'Finalized session totals per timezone-local day, composed from session_rollups_15m.',
    table: 'session_rollups_15m',
    bucketExpr: bucketUtc('toStartOfDay(cur.bucket_start, {tz:String})'),
    source: '15m',
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 500,
  }),
  defineSessionProvisional({
    id: 'analytics.sessions_provisional_day_local',
    summary:
      'Provisional session totals per timezone-local day, composed from session_facts_versions.',
    bucketExpr: bucketUtc('toStartOfDay(cur.session_start, {tz:String})'),
    source: '15m',
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 500,
  }),
]

// ---------------------------------------------------------------------------
// Entry, exit and bounce per page (ADR-0075, D-E1).
//
// Migration `0007_pages_hour_day.sql` states in its own header why the pages
// rollup excludes these: they are NOT ADDITIVE over an incremental view — a late
// second pageview has to undo a bounce the view already recorded — and it points
// at the finalizer as the thing that would make them possible. The finalizer
// shipped in M8. This is the read that was waiting for it.
//
// They come from the session facts and they cannot come from anywhere else.
// `session_rollups_15m`/`_1d` are keyed `(site_id, bucket_start)` with NO path
// dimension (migration 0014), and `pages_15m`/`_1d` are event-grain with no
// session in them. So this operation sits on the same provisional-over-facts
// layer the session totals sit on, and reads the fact table by the contract
// migration 0013 mandates:
//
//   **argMax over `version` per `(site_id, session_id)` FIRST, then filter
//   `retracted = 0`.** Filtering `retracted = 0` before the version selection
//   discards the tombstone and resurrects the stale version underneath it, which
//   is the exact bug the tombstone exists to prevent.
//
// One session contributes two rows — its entry path and its exit path — through
// a fixed two-element `arrayJoin`. A single-page session contributes both at the
// same path, which is correct: it entered there and it left there, and
// `uniqExact` still counts it as one session.
//
// **Bounce is derived, never stored twice** (0013's comment on `engaged`), and it
// is counted on the ENTRY row alone: a bounce is a property of where the visit
// began. Its denominator is therefore `entrances`, which is returned beside it so
// a ratio computed anywhere names the number it was divided by.
//
// A session with no pageview at all — a visit that fired only a custom event —
// carries the empty entry/exit path, and the empty path is dropped rather than
// returned as a row. It is not a page, and the pages report this decorates has no
// row for it either.
// ---------------------------------------------------------------------------

function definePageSessions(definition: {
  id: string
  source: RollupResolution
  alignment: RangeAlignment
  summary: string
  /**
   * Whether this variant restricts itself to the sessions a filter set selects
   * (ADR-0075, D-F1).
   *
   * The filter lands INSIDE the fact subquery rather than beside the join,
   * because here the fact rows are the population being counted — there is no
   * events_raw side at all — so a filtered entry/exit read needs no raw access
   * and no session-hint join. It is the one filtered read that is genuinely
   * cheaper than its unfiltered self.
   */
  filtered?: boolean
}): QueryOperation {
  const filtered = definition.filtered === true
  const sql = [
    'SELECT',
    '  tupleElement(live.slot, 1) AS page_path,',
    '  countIf(tupleElement(live.slot, 2) = 1) AS entrances,',
    '  countIf(tupleElement(live.slot, 3) = 1) AS exits,',
    '  countIf(tupleElement(live.slot, 2) = 1 AND live.engaged = 0) AS bounces,',
    // Distinct sessions that entered OR exited at this path, which is what the
    // two arrayJoin rows of a single-page session must not double.
    '  uniqExact(live.session_id) AS sessions',
    'FROM (',
    '  SELECT',
    '    cur.session_id AS session_id,',
    '    cur.engaged AS engaged,',
    '    arrayJoin([',
    '      (cur.entry_page_path, toUInt8(1), toUInt8(0)),',
    '      (cur.exit_page_path, toUInt8(0), toUInt8(1))',
    '    ]) AS slot',
    '  FROM (',
    '    SELECT',
    '      sfv.session_id AS session_id,',
    '      argMax(sfv.entry_page_path, sfv.version) AS entry_page_path,',
    '      argMax(sfv.exit_page_path, sfv.version) AS exit_page_path,',
    '      argMax(sfv.engaged, sfv.version) AS engaged,',
    ...(filtered
      ? FILTER_DIMENSIONS.map(
          (dimension) => `      argMax(sfv.${dimension}, sfv.version) AS ${dimension},`,
        )
      : []),
    '      argMax(sfv.retracted, sfv.version) AS retracted',
    '    FROM session_facts_versions AS sfv',
    '    WHERE sfv.site_id = {site_id:UUID}',
    "      AND sfv.session_start >= toDateTime64({from:String}, 3, 'UTC')",
    "      AND sfv.session_start <  toDateTime64({to:String}, 3, 'UTC')",
    '    GROUP BY sfv.site_id, sfv.session_id',
    '  ) AS cur',
    '  WHERE cur.retracted = 0',
    ...(filtered ? [filterConjuncts('cur').replace(/^ {4}/gm, '  ')] : []),
    ') AS live',
    "WHERE tupleElement(live.slot, 1) != ''",
    'GROUP BY page_path',
    // Ranked by the two measures together, because the api may cut the merged
    // list by either one and a list ordered by only one of them would arrive
    // already missing the top of the other.
    'ORDER BY entrances + exits DESC',
    'LIMIT {limit:UInt32}',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    // The facts layer is revisable until the finalizer's watermark passes it, so
    // the short TTL — the same choice, for the same reason, as the provisional
    // session operations above.
    cacheProfile: 'default',
    params: filtered
      ? filteredParamsSchema({
          maxRangeMs: Math.min(maxRangeFor[definition.source], FILTERED_MAX_SPAN_MS),
          alignment: definition.alignment,
          withTimezone: false,
          withLimit: true,
        })
      : rangeParamsSchema({
          // Deliberately the pages REPORT's cap rather than a tighter one of its
          // own: this decorates that report, and a decoration that refuses a
          // range the report answers would render as missing data on a working
          // screen.
          maxRangeMs: maxRangeFor[definition.source],
          alignment: definition.alignment,
          // No cutover and no zone. An imported provider day has no session in
          // it — no entry, no exit, no bounce — so there is nothing on the
          // imported side of the partition for this to either include or
          // exclude. Binding the cutover would be a bound value the SQL never
          // uses, which the definition checker rejects.
          withTimezone: false,
          withLimit: true,
          withImport: false,
        }),
    sql,
    maxRows: TOP_N_MAX,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      limit: params['limit'] as number,
      ...(filtered ? bindFilters(params['filters'] as readonly AnalyticsFilter[]) : {}),
    }),
  })
}

const pageSessionOperations: readonly QueryOperation[] = [
  definePageSessions({
    id: 'analytics.page_sessions_hour',
    source: '15m',
    alignment: 'quarter',
    summary:
      'Entrances, exits, bounces and sessions per page path from the session facts. Quarter-hour-aligned.',
  }),
  definePageSessions({
    id: 'analytics.page_sessions_day',
    source: '1d',
    alignment: 'day',
    summary:
      'Entrances, exits, bounces and sessions per page path from the session facts. UTC-day-aligned.',
  }),
]

// ---------------------------------------------------------------------------
// Funnels (docs snapshot 02 §15; plan Milestone 8 item 7, acceptance criterion 4).
//
// The one operation family that reads events_raw — §15 computes funnels over the
// event facts, not a rollup — and it earns that with a bounded query: strict site
// scope, a capped span (MAX_FUNNEL_RANGE_MS), a fixed step width, and a
// single-row result (the per-step unit counts, never per-unit rows). ClickHouse
// `windowFunnel` mirrors the pure `computeFunnel` reference in @openanalytics/
// domain: ordered steps within a window, one row per aggregation unit. The unit
// is the resolved identity (`visitor`) or that identity paired with the client
// session hint (`session`) — a constant GROUP BY per operation, never a parameter.
//
// The event's funnel key is the page path for a pageview and the event name
// otherwise, matched against the bound step keys. Steps beyond {step_count} are
// gated off by the `{step_count} >= k` conjunct, so a shorter funnel binds the
// unused step slots to a harmless empty string.
// ---------------------------------------------------------------------------

const FUNNEL_MAX_STEPS = 8

/** `{step_count} >= k AND event_key = {step_k}` for each fixed slot. */
function funnelStepConditions(): string {
  const conditions: string[] = []
  for (let k = 1; k <= FUNNEL_MAX_STEPS; k += 1) {
    const tail = k === FUNNEL_MAX_STEPS ? '' : ','
    conditions.push(
      `      ({step_count:UInt8} >= ${k}) AND ` +
        `(if(er.type = 'page_view', er.page_path, er.name) = {step_${k}:String})${tail}`,
    )
  }
  return conditions.join('\n')
}

/** `countIf(units.level >= k) AS step_k` for each fixed slot. */
function funnelStepCounts(): string {
  const counts: string[] = []
  for (let k = 1; k <= FUNNEL_MAX_STEPS; k += 1) {
    const tail = k === FUNNEL_MAX_STEPS ? '' : ','
    counts.push(`  countIf(units.level >= ${k}) AS step_${k}${tail}`)
  }
  return counts.join('\n')
}

const FUNNEL_MAX_SPAN_MS = 92 * MS_PER_DAY
const FUNNEL_MAX_WINDOW_MS = 30 * MS_PER_DAY

const funnelParamsSchema = z
  .strictObject({
    site_id: z.uuid(),
    from: utcInstantSchema,
    to: utcInstantSchema,
    steps: z.array(z.string().min(1).max(512)).min(2).max(FUNNEL_MAX_STEPS),
    window_ms: z.number().int().min(1).max(FUNNEL_MAX_WINDOW_MS),
  })
  .superRefine((value, ctx) => {
    const fromMs = Date.parse(value.from)
    const toMs = Date.parse(value.to)
    if (fromMs >= toMs) {
      ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
      return
    }
    if (toMs - fromMs > FUNNEL_MAX_SPAN_MS) {
      ctx.addIssue({
        code: 'custom',
        message: `funnel range span exceeds the ${FUNNEL_MAX_SPAN_MS}ms synchronous maximum`,
      })
    }
  })

function defineFunnel(definition: {
  id: string
  unitExpr: string
  summary: string
}): QueryOperation {
  const sql = [
    'SELECT',
    funnelStepCounts(),
    'FROM (',
    '  SELECT',
    '    windowFunnel({window_ms:UInt64})(',
    // windowFunnel's timestamp argument accepts Date/DateTime and unsigned
    // integers; toUnixTimestamp64Milli returns Int64, so cast to UInt64 (the
    // value is always positive) to keep the millisecond window unit.
    '      toUInt64(toUnixTimestamp64Milli(er.occurred_at)),',
    funnelStepConditions(),
    '    ) AS level',
    '  FROM events_raw AS er',
    '  WHERE er.site_id = {site_id:UUID}',
    "    AND er.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND er.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    "    AND er.type IN ('page_view', 'custom_event', 'conversion')",
    `  GROUP BY ${definition.unitExpr}`,
    ') AS units',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    allowRawEvents: true,
    params: funnelParamsSchema,
    sql,
    maxRows: 1,
    bind: (params) => {
      const steps = params.steps
      const bound: Record<string, QueryParameterValue> = {
        site_id: params.site_id,
        from: toClickHouseInstant(params.from),
        to: toClickHouseInstant(params.to),
        window_ms: params.window_ms,
        step_count: steps.length,
      }
      for (let k = 1; k <= FUNNEL_MAX_STEPS; k += 1) {
        bound[`step_${k}`] = steps[k - 1] ?? ''
      }
      return bound
    },
  })
}

const funnelOperations: readonly QueryOperation[] = [
  // The unit is the D-102 anonymous id — the ADR-0036 D3 identity rule for
  // unit-counting reads. This is byte-identical to the resolved-identity
  // expression it replaces on every row the funnel can see: the population is
  // page_view/custom_event/conversion, and `user_id` is non-empty only on
  // identify-typed rows, which are excluded above. The old expression merely
  // looked like it folded identity; the new one says what it counts.
  defineFunnel({
    id: 'analytics.funnel_visitor',
    summary: 'Ordered step funnel over events_raw, one unit per anonymous visitor id.',
    unitExpr: 'er.anonymous_id',
  }),
  defineFunnel({
    id: 'analytics.funnel_session',
    summary:
      'Ordered step funnel over events_raw, one unit per (anonymous id, client session hint).',
    unitExpr: '(er.anonymous_id, er.session_id)',
  }),
]

// ---------------------------------------------------------------------------
// Recent visitors (ADR-0024).
//
// The second family that reads events_raw, and it earns the exception the same
// way the funnel does: a hard site filter, a span capped far below the funnel's,
// a row cap, and an aggregate that returns one row per visitor rather than one
// row per event. It exists because the realtime feed is deliberately ephemeral —
// it answers "what is happening", and this answers "what happened in the last
// couple of hours", which no rollup can, because every rollup has already
// aggregated the visitor away.
//
// Both operations key a row on the D-102 anonymous id, exactly as the funnel
// counts its units, so "one visitor" means the same thing on every surface that
// says it (ADR-0036 D3). The customer's identify() hash is not a competing row
// identity: it exists only on the identify event, so keying rows on the
// resolved-identity expression split one identified person into their anonymous
// row plus a phantom user_id row with zero pageviews and an empty trail.
// Instead the identify hash is FOLDED onto the anonymous group as an attribute
// (argMaxIf below) — the identify row carries both ids, so it lands in the
// person's own group and the fold is proven by the event itself.
//
// The data is provisional by nature: it reads the leading edge of ingest, where
// the sessionizer has not finalized and late events can still arrive. The API
// says so in the response metadata rather than pretending otherwise.
// ---------------------------------------------------------------------------

const RECENT_VISITORS_MAX_SPAN_MS = 24 * MS_PER_HOUR
const RECENT_VISITORS_MAX_ROWS = 200
const VISITOR_TRAIL_MAX_ROWS = 500

/** The row identity of every per-visitor read: the D-102 anonymous id
 * (ADR-0036 D3). Folding, where a surface needs it, is an argMaxIf over the
 * group — never a second row identity. */
const VISITOR_IDENTITY = 'er.anonymous_id'

const recentWindowSchema = z
  .strictObject({
    site_id: z.uuid(),
    from: utcInstantSchema,
    to: utcInstantSchema,
    limit: z.number().int().min(1).max(RECENT_VISITORS_MAX_ROWS).default(TOP_N_DEFAULT),
  })
  .superRefine((value, ctx) => {
    const fromMs = Date.parse(value.from)
    const toMs = Date.parse(value.to)
    if (fromMs >= toMs) {
      ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
      return
    }
    if (toMs - fromMs > RECENT_VISITORS_MAX_SPAN_MS) {
      ctx.addIssue({
        code: 'custom',
        message: `recent-visitor range span exceeds the ${RECENT_VISITORS_MAX_SPAN_MS}ms maximum`,
      })
    }
  })

const recentVisitorsOperation = defineOperation({
  id: 'analytics.recent_visitors',
  summary: 'Visitors active in a short recent window, newest last-seen first.',
  requiresSiteScope: true,
  allowRawEvents: true,
  params: recentWindowSchema,
  sql: [
    'SELECT',
    `  ${VISITOR_IDENTITY} AS visitor,`,
    // argMaxIf rather than any() or a plain argMax(): the label a visitor is
    // shown under is the one from their most recent event *that carries it*,
    // deterministically, not whichever row the aggregate happened to read first.
    // These columns are empty whenever the label is simply unknown — a custom
    // event sent without page context, a GeoLite2 miss — and a plain argMax()
    // would let one such event blank an otherwise well-labelled visitor's row.
    // Each label is judged on its own, so a geo miss does not cost the browser.
    "  argMaxIf(er.country, er.occurred_at, er.country != '') AS country,",
    "  argMaxIf(er.device_type, er.occurred_at, er.device_type != '') AS device_type,",
    "  argMaxIf(er.browser, er.occurred_at, er.browser != '') AS browser,",
    "  argMaxIf(er.os, er.occurred_at, er.os != '') AS os,",
    // The identify() fold (ADR-0036 D3): the customer's hashed user id from the
    // group's most recent identify event, empty when the visitor never
    // identified. Not on the response contract — it is the join key the revenue
    // fields use server-side, and a pseudonym has no business on a row that
    // already has an identity.
    "  argMaxIf(er.user_id, er.occurred_at, er.user_id != '') AS user_id,",
    '  min(er.occurred_at) AS first_seen,',
    '  max(er.occurred_at) AS last_seen,',
    "  countIf(er.type = 'page_view') AS pageviews",
    'FROM events_raw AS er',
    'WHERE er.site_id = {site_id:UUID}',
    "  AND er.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "  AND er.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    'GROUP BY visitor',
    // An event with no resolvable identity is not a visitor to list.
    "HAVING visitor != ''",
    'ORDER BY last_seen DESC, visitor ASC',
    'LIMIT {limit:UInt32}',
  ].join('\n'),
  maxRows: RECENT_VISITORS_MAX_ROWS,
  // Uncacheable, and that is the point (ADR-0035, D7). Its window ends at `now`
  // rather than on a whole minute, so every request would mint a key that can
  // never be read again — the entry would not serve one hit and would evict a
  // key from the shared bounded LRU that could have. A live surface pays for its
  // own freshness; it does not get to spend the cache other reads depend on.
  cacheable: false,
  bind: (params) => ({
    site_id: params.site_id,
    from: toClickHouseInstant(params.from),
    to: toClickHouseInstant(params.to),
    limit: params.limit,
  }),
})

/**
 * One visitor's page views in the same window, newest first.
 *
 * Ordered descending and reversed by the caller rather than ascending, because
 * the row cap has to bite somewhere: cutting the *oldest* activity of a very
 * busy visitor keeps the part of the trail anyone is looking at, while an
 * ascending order with the same cap would drop the newest.
 *
 * Sessions are not grouped here. The session hint is returned per row and the
 * API groups on it, the same key `analytics.funnel_session` aggregates by, so
 * both surfaces mean the same thing by "a session".
 *
 * The match is by anonymous id **or** by a session the visitor shares with
 * another id on the same UTC date — see the WHERE clause. Without that second
 * branch a visitor whose IP moved mid-visit reads as somebody with no pageviews
 * at all, which is what the realtime board was reporting: live presence, an
 * empty trail, and no way to tell the two apart from a genuine ingest gap.
 */
const visitorTrailOperation = defineOperation({
  id: 'analytics.visitor_trail',
  summary: 'One visitor’s page views in a short recent window, newest first.',
  requiresSiteScope: true,
  allowRawEvents: true,
  params: z
    .strictObject({
      site_id: z.uuid(),
      from: utcInstantSchema,
      to: utcInstantSchema,
      visitor: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(VISITOR_TRAIL_MAX_ROWS).default(VISITOR_TRAIL_MAX_ROWS),
    })
    .superRefine((value, ctx) => {
      const fromMs = Date.parse(value.from)
      const toMs = Date.parse(value.to)
      if (fromMs >= toMs) {
        ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
        return
      }
      if (toMs - fromMs > RECENT_VISITORS_MAX_SPAN_MS) {
        ctx.addIssue({
          code: 'custom',
          message: `visitor-trail range span exceeds the ${RECENT_VISITORS_MAX_SPAN_MS}ms maximum`,
        })
      }
    }),
  sql: [
    'SELECT',
    '  er.session_id AS session_id,',
    '  er.event_id AS event_id,',
    '  er.occurred_at AS occurred_at,',
    '  er.page_path AS page_path,',
    '  er.page_title AS page_title,',
    '  er.referrer_domain AS referrer_domain,',
    '  er.utm_source AS utm_source,',
    '  er.utm_medium AS utm_medium',
    'FROM events_raw AS er',
    'WHERE er.site_id = {site_id:UUID}',
    "  AND er.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "  AND er.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    "  AND er.type = 'page_view'",
    '  AND (',
    // The rotation branch (D-102, `packages/domain/src/session.ts`): the identity
    // is `HMAC(ip/ua-class, site, UTC-date, …)`, so one visitor's own pageview
    // can be filed under a *different* id than the one being asked about — an IP
    // that moved mid-visit. The shared client-session hint is the evidence that
    // it is the same person, the same evidence the sessionizer's identity bridge
    // acts on, so the trail has to read it the same way or the two surfaces
    // disagree about who one visitor is.
    //
    // Bounded exactly as the bridge is: a non-empty hint (an empty one would
    // pool every hintless server-side row into one pseudo-visitor) and the same
    // UTC date, so this never links across the daily rotation.
    //
    // `(session, date)` as one tuple rather than two independent `IN`s. Two sets
    // would admit their cross-product — a session from one date paired with
    // another date the visitor was seen on — which is unreachable today only
    // because an anonymous id never spans two dates by construction. Pairing
    // them says what is meant without leaning on that, and it costs one table
    // scan instead of two (measured on production: 20,370 rows read against
    // 30,555, 18 ms against 24 ms).
    `    ${VISITOR_IDENTITY} = {visitor:String}`,
    '    OR (',
    "      er.session_id != ''",
    '      AND (er.session_id, toDate(er.occurred_at)) IN (',
    '        SELECT session_id, toDate(occurred_at) FROM events_raw',
    '        WHERE site_id = {site_id:UUID}',
    '          AND anonymous_id = {visitor:String}',
    "          AND occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "          AND occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    "          AND session_id != ''",
    '      )',
    '    )',
    '  )',
    'ORDER BY occurred_at DESC, event_id DESC',
    'LIMIT {limit:UInt32}',
  ].join('\n'),
  maxRows: VISITOR_TRAIL_MAX_ROWS,
  // Uncacheable for the same reason its sibling above is (ADR-0035, D7): the
  // window ends at `now`, so a cached entry could never be read twice.
  cacheable: false,
  bind: (params) => ({
    site_id: params.site_id,
    from: toClickHouseInstant(params.from),
    to: toClickHouseInstant(params.to),
    visitor: params.visitor,
    limit: params.limit,
  }),
})

// ---------------------------------------------------------------------------
// Revenue on the visitor surfaces (ADR-0036 CP7).
//
// Two reads that join the attribution facts to the money facts so the api can
// put an attributed-revenue marker on a visitor row. Both are additive: no
// ingest, no attribution and no existing revenue operation changes. The data
// already exists — `revenue_attributions.visitor_id` is written with the
// resolved identity of the matched signal (the identify() hash for an
// identified buyer, the anonymous id otherwise), `occurred_at` mirrors the
// charge's own instant (the window filter), and `revenue_events` carries the
// amounts. So a visitor row's revenue is matched on EITHER of its two ids —
// the row's anonymous key or its folded user_id (ADR-0033 CP4's two-lookup
// merge, seen from the read side).
//
// Only converted, attributed charges count: refunds and disputes have no
// visitor row of their own, an unmatched charge has an empty visitor_id, a
// failed/canceled charge is never eligible for attribution, and an
// unconverted amount belongs in the summary's per-currency remainder — folded
// in as zero it would understate a real payment.
//
// Both are `cacheable: false` for the ADR-0035 D7 reason: their window ends at
// `now`, so a cached entry could never be read twice.
// ---------------------------------------------------------------------------

const VISITOR_REVENUE_MAX_ROWS = 200
const VISITOR_REVENUE_ENTRIES_MAX_ROWS = 100

/** Current-version money facts of the window — the argMax read, never FINAL. */
const VISITOR_REVENUE_FACTS = [
  '  SELECT',
  '    re.object_id AS object_id,',
  '    argMax(re.object_kind, re.version) AS object_kind,',
  "    toDateTime64(argMax(re.occurred_at, re.version), 3, 'UTC') AS occurred_at,",
  '    argMax(re.status, re.version) AS status,',
  '    argMax(re.currency, re.version) AS currency,',
  '    argMax(re.gross_minor, re.version) AS gross_minor,',
  '    argMax(re.reporting_currency, re.version) AS reporting_currency,',
  '    argMax(re.reporting_gross_minor, re.version) AS reporting_gross_minor,',
  '    argMax(re.conversion_source, re.version) AS conversion_source',
  '  FROM revenue_events AS re',
  '  WHERE re.site_id = {site_id:UUID}',
  "    AND re.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
  "    AND re.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
  '  GROUP BY re.site_id, re.provider, re.object_id',
].join('\n')

/** Current-version attribution rows of the same window. */
const VISITOR_REVENUE_ATTRIBUTIONS = [
  '  SELECT',
  '    ra.object_id AS object_id,',
  '    argMax(ra.visitor_id, ra.version) AS visitor_id,',
  '    argMax(ra.lt_session_id, ra.version) AS lt_session_id',
  '  FROM revenue_attributions AS ra',
  '  WHERE ra.site_id = {site_id:UUID}',
  "    AND ra.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
  "    AND ra.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
  '  GROUP BY ra.site_id, ra.provider, ra.object_id',
].join('\n')

const VISITOR_REVENUE_ELIGIBLE = [
  "WHERE cur.object_kind = 'charge'",
  "  AND cur.status NOT IN ('failed', 'canceled', 'cancelled')",
  "  AND att.visitor_id != ''",
].join('\n')

const visitorRevenueOperation = defineOperation({
  id: 'analytics.visitor_revenue',
  summary: 'Attributed, converted charge totals per visitor identity in a recent window.',
  requiresSiteScope: true,
  params: z
    .strictObject({
      site_id: z.uuid(),
      from: utcInstantSchema,
      to: utcInstantSchema,
    })
    .superRefine((value, ctx) => {
      const fromMs = Date.parse(value.from)
      const toMs = Date.parse(value.to)
      if (fromMs >= toMs) {
        ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
        return
      }
      if (toMs - fromMs > RECENT_VISITORS_MAX_SPAN_MS) {
        ctx.addIssue({
          code: 'custom',
          message: `visitor-revenue range span exceeds the ${RECENT_VISITORS_MAX_SPAN_MS}ms maximum`,
        })
      }
    }),
  sql: [
    'SELECT',
    '  att.visitor_id AS visitor_key,',
    '  sum(cur.reporting_gross_minor) AS amount_minor,',
    // One value per site by construction: the projection materializes every
    // fact in the site's reporting currency.
    '  any(cur.reporting_currency) AS currency,',
    '  count() AS transaction_count',
    'FROM (',
    VISITOR_REVENUE_FACTS,
    ') AS cur',
    'INNER JOIN (',
    VISITOR_REVENUE_ATTRIBUTIONS,
    ') AS att ON att.object_id = cur.object_id',
    VISITOR_REVENUE_ELIGIBLE,
    // An unconverted charge has zeroed reporting amounts; folding those in
    // would show a real payment as worthless. It stays in the unconverted
    // remainder (analytics.revenue_unconverted), out of this marker entirely.
    "  AND cur.conversion_source != 'unavailable'",
    'GROUP BY att.visitor_id',
    'ORDER BY amount_minor DESC, visitor_key ASC',
    `LIMIT ${VISITOR_REVENUE_MAX_ROWS}`,
  ].join('\n'),
  maxRows: VISITOR_REVENUE_MAX_ROWS,
  cacheable: false,
  bind: (params) => ({
    site_id: params.site_id,
    from: toClickHouseInstant(params.from),
    to: toClickHouseInstant(params.to),
  }),
})

/**
 * One visitor's attributed charges in the window, oldest first — the entries
 * behind the trail endpoint's `revenue_events`.
 *
 * The visitor parameter is the row identity, the anonymous id (ADR-0036 D3).
 * The attribution row may instead be keyed on the identify() hash, so the
 * match widens through the linkage the data itself carries: any `user_id` an
 * identify event paired with this anonymous id inside the window. An identify
 * that happened only outside the window cannot widen the match — which is the
 * window rule applied to identity, not a gap.
 *
 * Unconverted charges ARE listed (a real payment renders honestly in its
 * original currency; the api's renderer nulls the reporting amount) — they are
 * excluded only from the summed marker, and the api derives that sum with the
 * same rule the list operation applies.
 */
const visitorRevenueEntriesOperation = defineOperation({
  id: 'analytics.visitor_revenue_entries',
  summary: "One visitor identity's attributed charges in a recent window, oldest first.",
  requiresSiteScope: true,
  allowRawEvents: true,
  params: z
    .strictObject({
      site_id: z.uuid(),
      from: utcInstantSchema,
      to: utcInstantSchema,
      visitor: z.string().min(1).max(128),
    })
    .superRefine((value, ctx) => {
      const fromMs = Date.parse(value.from)
      const toMs = Date.parse(value.to)
      if (fromMs >= toMs) {
        ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
        return
      }
      if (toMs - fromMs > RECENT_VISITORS_MAX_SPAN_MS) {
        ctx.addIssue({
          code: 'custom',
          message: `visitor-revenue range span exceeds the ${RECENT_VISITORS_MAX_SPAN_MS}ms maximum`,
        })
      }
    }),
  sql: [
    'SELECT',
    '  cur.object_id AS object_id,',
    '  cur.occurred_at AS occurred_at,',
    '  cur.status AS status,',
    '  cur.currency AS currency,',
    '  cur.gross_minor AS gross_minor,',
    '  cur.reporting_currency AS reporting_currency,',
    '  cur.reporting_gross_minor AS reporting_gross_minor,',
    '  cur.conversion_source AS conversion_source,',
    '  att.lt_session_id AS session_id',
    'FROM (',
    VISITOR_REVENUE_FACTS,
    ') AS cur',
    'INNER JOIN (',
    VISITOR_REVENUE_ATTRIBUTIONS,
    ') AS att ON att.object_id = cur.object_id',
    VISITOR_REVENUE_ELIGIBLE,
    '  AND (att.visitor_id = {visitor:String}',
    '       OR att.visitor_id IN (',
    '         SELECT DISTINCT er.user_id FROM events_raw AS er',
    '         WHERE er.site_id = {site_id:UUID}',
    '           AND er.anonymous_id = {visitor:String}',
    "           AND er.user_id != ''",
    "           AND er.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "           AND er.occurred_at <  toDateTime64({to:String}, 3, 'UTC')))",
    'ORDER BY cur.occurred_at ASC, cur.object_id ASC',
    `LIMIT ${VISITOR_REVENUE_ENTRIES_MAX_ROWS}`,
  ].join('\n'),
  maxRows: VISITOR_REVENUE_ENTRIES_MAX_ROWS,
  cacheable: false,
  bind: (params) => ({
    site_id: params.site_id,
    from: toClickHouseInstant(params.from),
    to: toClickHouseInstant(params.to),
    visitor: params.visitor,
  }),
})

const recentVisitorOperations: readonly QueryOperation[] = [
  recentVisitorsOperation,
  visitorTrailOperation,
  visitorRevenueOperation,
  visitorRevenueEntriesOperation,
]

// ---------------------------------------------------------------------------
// Revenue (ADR-0033, D7; ClickHouse 0016/0017/0018). Milestone 12 Checkpoint 5.
//
// Four families, and the split between them is the D-212 layering made visible:
//
//   * the two BUCKET families (timeseries, summary) read `revenue_15m`/`_1d` — a
//     versioned swap target, so every read is `argMax(col, generation)` per
//     (site, bucket) and then a sum across the range, never `FINAL`;
//   * the two OBJECT families (transactions, journey) read the FACTS
//     (`revenue_events`, `revenue_attributions`) — also versioned, so also
//     `argMax(col, version)` per object, never `FINAL`;
//   * one remainder operation reads the facts to answer a question the buckets
//     structurally cannot: how much money is in the range that could NOT be
//     converted, per original currency. 0018 explains why that total is not a
//     bucket column (it would need `currency` in the sort key, which breaks the
//     unit of replacement).
//
// None of them reads `events_raw`, so none needs `allowRawEvents`. Every one
// binds `site_id` and is site-scoped — the registry's standing boundary, and the
// only thing between an owner of one site and the revenue of another.
//
// Every aggregate is alias-qualified through the table alias (`rr.`, `re.`,
// `ra.`), because CI's ClickHouse resolves a bare name a SELECT alias shadows to
// the alias and throws ILLEGAL_AGGREGATION.
// ---------------------------------------------------------------------------

/**
 * The per-bucket measures, summed across a range.
 *
 * `cur.` rather than the rollup alias: these run over the argMax subquery's
 * result, which is the current generation of each bucket. Summing the table
 * directly would add every superseded generation of every bucket — the exact
 * mistake ReplacingMergeTree makes easy and the read rule exists to prevent.
 */
const REVENUE_MEASURE_SELECT = [
  '  sum(cur.charge_gross_minor) AS charge_gross_minor,',
  '  sum(cur.refund_minor) AS refund_minor,',
  '  sum(cur.dispute_withdrawn_minor) AS dispute_withdrawn_minor,',
  '  sum(cur.dispute_reinstated_minor) AS dispute_reinstated_minor,',
  '  sum(cur.fee_minor) AS fee_minor,',
  '  sum(cur.net_minor) AS net_minor,',
  '  sum(cur.charge_count) AS charge_count,',
  '  sum(cur.refund_count) AS refund_count,',
  '  sum(cur.dispute_count) AS dispute_count,',
  '  sum(cur.unconverted_count) AS unconverted_count',
].join('\n')

/** The current generation of every bucket in the range, as a subquery. */
function currentRevenueBuckets(table: string): string {
  return [
    'FROM (',
    '  SELECT',
    '    rr.bucket_start AS bucket_start,',
    '    argMax(rr.charge_gross_minor, rr.generation) AS charge_gross_minor,',
    '    argMax(rr.refund_minor, rr.generation) AS refund_minor,',
    '    argMax(rr.dispute_withdrawn_minor, rr.generation) AS dispute_withdrawn_minor,',
    '    argMax(rr.dispute_reinstated_minor, rr.generation) AS dispute_reinstated_minor,',
    '    argMax(rr.fee_minor, rr.generation) AS fee_minor,',
    '    argMax(rr.net_minor, rr.generation) AS net_minor,',
    '    argMax(rr.charge_count, rr.generation) AS charge_count,',
    '    argMax(rr.refund_count, rr.generation) AS refund_count,',
    '    argMax(rr.dispute_count, rr.generation) AS dispute_count,',
    '    argMax(rr.unconverted_count, rr.generation) AS unconverted_count',
    `  FROM ${table} AS rr`,
    '  WHERE rr.site_id = {site_id:UUID}',
    "    AND rr.bucket_start >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND rr.bucket_start <  toDateTime64({to:String}, 3, 'UTC')",
    '  GROUP BY rr.site_id, rr.bucket_start',
    ') AS cur',
  ].join('\n')
}

function defineRevenueTimeseries(definition: {
  id: string
  summary: string
  table: string
  bucketExpr: string
  source: RollupResolution
  alignment: RangeAlignment
  withTimezone: boolean
  maxRows: number
}): QueryOperation {
  const sql = [
    'SELECT',
    `  ${definition.bucketExpr} AS bucket,`,
    REVENUE_MEASURE_SELECT,
    currentRevenueBuckets(definition.table),
    'GROUP BY bucket',
    'ORDER BY bucket',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      withTimezone: definition.withTimezone,
      withLimit: false,
    }),
    sql,
    maxRows: definition.maxRows,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      ...(definition.withTimezone ? { tz: params['timezone'] as string } : {}),
    }),
  })
}

function defineRevenueSummary(definition: {
  id: string
  summary: string
  table: string
  source: RollupResolution
  alignment: RangeAlignment
}): QueryOperation {
  const sql = ['SELECT', REVENUE_MEASURE_SELECT, currentRevenueBuckets(definition.table)].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    params: rangeParamsSchema({
      maxRangeMs: maxRangeFor[definition.source],
      alignment: definition.alignment,
      // A total has no bucket to label, so no zone is bound. The zone still
      // decided the range endpoints; it just has nothing to do inside the query.
      withTimezone: false,
      withLimit: false,
    }),
    sql,
    maxRows: 1,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
    }),
  })
}

/**
 * The unconverted remainder, per ORIGINAL currency.
 *
 * The one revenue read that goes to the facts for a range total, and it exists
 * because the buckets cannot answer it: 0018 stores `unconverted_count` and no
 * per-currency amount, since a currency dimension would change the unit of
 * replacement from `(site, bucket)` to `(site, bucket, currency)` and a currency
 * that disappeared from a recomputed bucket could then never be replaced away.
 *
 * `conversion_source` is a column a *version* can change — an ECB backfill can
 * turn `unavailable` into `ecb` — so it is filtered AFTER the grouping, never
 * before. `occurred_at` is filtered before, because a money object's occurrence
 * does not move between versions and the pre-filter is what keeps the scan
 * inside the right monthly partitions.
 *
 * Amounts are magnitudes per kind, exactly as the facts store them, and the api
 * applies the D2d signs. Aggregating signed values here would mean teaching this
 * query the dispute lifecycle, which lives in one pure function in the worker
 * and should not have a second home in SQL.
 */
const REVENUE_UNCONVERTED_MAX_ROWS = 100

const revenueUnconvertedOperation = defineOperation({
  id: 'analytics.revenue_unconverted',
  summary: 'Unconverted revenue facts in a range, totalled per original currency.',
  requiresSiteScope: true,
  params: rangeParamsSchema({
    // The hour-rollup cap (400 days), not the day-rollup one (3,660). This scans
    // FACTS and groups by object, so its cost tracks a site's transaction count
    // rather than a bucket count -- a ten-year span would be a full-history scan
    // dressed up as a range query. 400 days also matches the deepest span any
    // other fact-touching read here is allowed, so the summary refuses the same
    // ranges its own timeseries does.
    maxRangeMs: MAX_SPAN_HOUR_MS,
    alignment: 'quarter',
    withTimezone: false,
    withLimit: false,
  }),
  sql: [
    'SELECT',
    '  cur.currency AS currency,',
    "  sumIf(cur.gross_minor, cur.object_kind = 'charge') AS charge_gross_minor,",
    "  sumIf(cur.gross_minor, cur.object_kind = 'refund') AS refund_minor,",
    "  sumIf(cur.gross_minor, cur.object_kind = 'dispute') AS dispute_minor,",
    '  count() AS transactions',
    'FROM (',
    '  SELECT',
    '    argMax(re.currency, re.version) AS currency,',
    '    argMax(re.object_kind, re.version) AS object_kind,',
    '    argMax(re.status, re.version) AS status,',
    '    argMax(re.gross_minor, re.version) AS gross_minor,',
    '    argMax(re.conversion_source, re.version) AS conversion_source',
    '  FROM revenue_events AS re',
    '  WHERE re.site_id = {site_id:UUID}',
    "    AND re.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND re.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    '  GROUP BY re.site_id, re.provider, re.object_id',
    ') AS cur',
    "WHERE cur.conversion_source = 'unavailable'",
    // The same eligibility rule the rollup applies: an object that moved no
    // money is not a remainder, it is nothing.
    "  AND cur.status NOT IN ('failed', 'canceled', 'cancelled')",
    'GROUP BY cur.currency',
    'ORDER BY charge_gross_minor DESC, currency ASC',
    `LIMIT ${REVENUE_UNCONVERTED_MAX_ROWS}`,
  ].join('\n'),
  maxRows: REVENUE_UNCONVERTED_MAX_ROWS,
  bind: (params: Record<string, unknown>) => ({
    site_id: params['site_id'] as string,
    from: toClickHouseInstant(params['from'] as string),
    to: toClickHouseInstant(params['to'] as string),
  }),
})

/**
 * The transactions list: current facts, keyset-paginated, with the attribution
 * joined on.
 *
 * ## The keyset
 *
 * `(occurred_at, object_id)` descending, which is the same tie-break every
 * ordered read in this repository uses for the same reason: `occurred_at` alone
 * is not unique (a batch import lands many charges on one second) and an
 * ambiguous order makes a cursor skip or repeat rows silently.
 *
 * The cursor predicate is applied **before** the grouping, and both halves of it
 * are legal there: `occurred_at` does not move between versions of an object,
 * and `object_id` is part of the GROUP BY key. A cursor of the epoch and an
 * empty id is the first page, which is why the api never has to build two
 * queries.
 *
 * ## The join
 *
 * `LEFT JOIN` on the attribution's own argMax, because an unmatched transaction
 * is a first-class outcome (D6) — it appears in every total and in this list
 * with `confidence = 'none'`, it simply has no journey. An inner join would make
 * unmatched revenue invisible, which is precisely the failure the ADR spends a
 * paragraph refusing.
 */
const REVENUE_TRANSACTIONS_MAX_ROWS = 201

const revenueTransactionsOperation = defineOperation({
  id: 'analytics.revenue_transactions',
  summary: 'Revenue transactions in a range, newest first, keyset-paginated with attribution.',
  requiresSiteScope: true,
  params: z
    .strictObject({
      site_id: z.uuid(),
      from: utcInstantSchema,
      to: utcInstantSchema,
      /** The cursor's `occurred_at`, or `to` on the first page. */
      cursor_occurred_at: utcInstantSchema,
      /** The cursor's object id, or the empty string on the first page. */
      cursor_object_id: z.string().max(255),
      limit: z.number().int().min(1).max(REVENUE_TRANSACTIONS_MAX_ROWS),
    })
    .superRefine((value, ctx) => {
      const fromMs = Date.parse(value.from)
      const toMs = Date.parse(value.to)
      if (fromMs >= toMs) {
        ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
        return
      }
      if (toMs - fromMs > MAX_SPAN_DAY_MS) {
        ctx.addIssue({
          code: 'custom',
          message: `transactions range span exceeds the ${MAX_SPAN_DAY_MS}ms maximum`,
        })
      }
    }),
  sql: [
    'SELECT',
    '  cur.object_id AS object_id,',
    '  cur.provider AS provider,',
    '  cur.object_kind AS object_kind,',
    '  cur.occurred_at AS occurred_at,',
    '  cur.status AS status,',
    '  cur.livemode AS livemode,',
    '  cur.currency AS currency,',
    '  cur.gross_minor AS gross_minor,',
    '  cur.fee_minor AS fee_minor,',
    '  cur.net_minor AS net_minor,',
    '  cur.reporting_currency AS reporting_currency,',
    '  cur.reporting_gross_minor AS reporting_gross_minor,',
    '  cur.reporting_net_minor AS reporting_net_minor,',
    '  cur.conversion_source AS conversion_source,',
    '  cur.conversion_rate AS conversion_rate,',
    '  cur.conversion_rate_date AS conversion_rate_date,',
    '  cur.parent_object_id AS parent_object_id,',
    '  cur.order_id AS order_id,',
    '  cur.product_name AS product_name,',
    '  att.matched_via AS matched_via,',
    '  att.confidence AS confidence,',
    '  att.identity_scope AS identity_scope',
    'FROM (',
    '  SELECT',
    '    re.object_id AS object_id,',
    '    re.provider AS provider,',
    '    argMax(re.object_kind, re.version) AS object_kind,',
    "    toDateTime64(argMax(re.occurred_at, re.version), 3, 'UTC') AS occurred_at,",
    '    argMax(re.status, re.version) AS status,',
    '    argMax(re.livemode, re.version) AS livemode,',
    '    argMax(re.currency, re.version) AS currency,',
    '    argMax(re.gross_minor, re.version) AS gross_minor,',
    '    argMax(re.fee_minor, re.version) AS fee_minor,',
    '    argMax(re.net_minor, re.version) AS net_minor,',
    '    argMax(re.reporting_currency, re.version) AS reporting_currency,',
    '    argMax(re.reporting_gross_minor, re.version) AS reporting_gross_minor,',
    '    argMax(re.reporting_net_minor, re.version) AS reporting_net_minor,',
    '    argMax(re.conversion_source, re.version) AS conversion_source,',
    '    argMax(re.conversion_rate, re.version) AS conversion_rate,',
    '    argMax(re.conversion_rate_date, re.version) AS conversion_rate_date,',
    '    argMax(re.parent_object_id, re.version) AS parent_object_id,',
    '    argMax(re.order_id, re.version) AS order_id,',
    '    argMax(re.product_name, re.version) AS product_name',
    '  FROM revenue_events AS re',
    '  WHERE re.site_id = {site_id:UUID}',
    "    AND re.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND re.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    "    AND (re.occurred_at < toDateTime64({cursor_occurred_at:String}, 3, 'UTC')",
    "         OR (re.occurred_at = toDateTime64({cursor_occurred_at:String}, 3, 'UTC')",
    '             AND re.object_id < {cursor_object_id:String}))',
    '  GROUP BY re.site_id, re.provider, re.object_id',
    ') AS cur',
    'LEFT JOIN (',
    '  SELECT',
    '    ra.object_id AS object_id,',
    '    argMax(ra.matched_via, ra.version) AS matched_via,',
    '    argMax(ra.confidence, ra.version) AS confidence,',
    '    argMax(ra.identity_scope, ra.version) AS identity_scope',
    '  FROM revenue_attributions AS ra',
    '  WHERE ra.site_id = {site_id:UUID}',
    "    AND ra.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND ra.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    '  GROUP BY ra.site_id, ra.provider, ra.object_id',
    ') AS att ON att.object_id = cur.object_id',
    'ORDER BY cur.occurred_at DESC, cur.object_id DESC',
    'LIMIT {limit:UInt32}',
  ].join('\n'),
  maxRows: REVENUE_TRANSACTIONS_MAX_ROWS,
  bind: (params) => ({
    site_id: params.site_id,
    from: toClickHouseInstant(params.from),
    to: toClickHouseInstant(params.to),
    cursor_occurred_at: toClickHouseInstant(params.cursor_occurred_at),
    cursor_object_id: params.cursor_object_id,
    limit: params.limit,
  }),
})

/**
 * One charge's attribution row — the journey endpoint's spine.
 *
 * Keyed by object id rather than by a range, so it needs no span cap: a charge
 * has exactly one attribution row per version and `argMax` collapses them to
 * one. The site filter is still the first predicate, and it is the whole
 * authorization boundary at this layer — a caller who guessed another site's
 * charge id gets nothing rather than somebody else's buyer journey.
 */
const revenueTransactionJourneyOperation = defineOperation({
  id: 'analytics.revenue_transaction_journey',
  summary: "One charge's current attribution row, including its bounded journey snapshot.",
  requiresSiteScope: true,
  params: z.strictObject({
    site_id: z.uuid(),
    object_id: z.string().min(1).max(255),
  }),
  sql: [
    'SELECT',
    '  ra.object_id AS object_id,',
    '  ra.provider AS provider,',
    '  max(ra.version) AS version,',
    "  toDateTime64(argMax(ra.occurred_at, ra.version), 3, 'UTC') AS occurred_at,",
    '  argMax(ra.model_version, ra.version) AS model_version,',
    '  argMax(ra.window_days, ra.version) AS window_days,',
    '  argMax(ra.matched_via, ra.version) AS matched_via,',
    '  argMax(ra.confidence, ra.version) AS confidence,',
    '  argMax(ra.identity_scope, ra.version) AS identity_scope,',
    '  argMax(ra.ft_session_id, ra.version) AS ft_session_id,',
    "  toDateTime64(argMax(ra.ft_session_start, ra.version), 3, 'UTC') AS ft_session_start,",
    '  argMax(ra.ft_referrer_domain, ra.version) AS ft_referrer_domain,',
    '  argMax(ra.ft_utm_source, ra.version) AS ft_utm_source,',
    '  argMax(ra.ft_utm_medium, ra.version) AS ft_utm_medium,',
    '  argMax(ra.ft_utm_campaign, ra.version) AS ft_utm_campaign,',
    '  argMax(ra.ft_utm_content, ra.version) AS ft_utm_content,',
    '  argMax(ra.ft_utm_term, ra.version) AS ft_utm_term,',
    '  argMax(ra.ft_entry_page, ra.version) AS ft_entry_page,',
    '  argMax(ra.lt_session_id, ra.version) AS lt_session_id,',
    "  toDateTime64(argMax(ra.lt_session_start, ra.version), 3, 'UTC') AS lt_session_start,",
    '  argMax(ra.lt_referrer_domain, ra.version) AS lt_referrer_domain,',
    '  argMax(ra.lt_utm_source, ra.version) AS lt_utm_source,',
    '  argMax(ra.lt_utm_medium, ra.version) AS lt_utm_medium,',
    '  argMax(ra.lt_utm_campaign, ra.version) AS lt_utm_campaign,',
    '  argMax(ra.lt_utm_content, ra.version) AS lt_utm_content,',
    '  argMax(ra.lt_utm_term, ra.version) AS lt_utm_term,',
    '  argMax(ra.lt_entry_page, ra.version) AS lt_entry_page,',
    '  argMax(ra.touchpoint_count, ra.version) AS touchpoint_count,',
    '  argMax(ra.journey_truncated, ra.version) AS journey_truncated,',
    '  argMax(ra.journey, ra.version) AS journey',
    'FROM revenue_attributions AS ra',
    'WHERE ra.site_id = {site_id:UUID}',
    '  AND ra.object_id = {object_id:String}',
    'GROUP BY ra.site_id, ra.provider, ra.object_id',
  ].join('\n'),
  maxRows: 4,
  bind: (params) => ({ site_id: params.site_id, object_id: params.object_id }),
})

/**
 * The money objects of one order: the charge itself plus everything pointing at
 * it.
 *
 * The journey is "the session touchpoints AND the money events of the order", so
 * a refund of the charge being inspected has to appear beside its charge. The
 * link is `parent_object_id`, which CP2's normalizer sets on every refund and
 * dispute precisely so this read exists — D2d put the refund's *money* in its own
 * bucket and explicitly kept the *link* for the journey.
 *
 * `parent_object_id` is filtered after the grouping: it is a value column a
 * version could in principle change, and the whole read is a handful of rows.
 *
 * ## The time bound, and why it is the request's range rather than the charge's
 *
 * Without one this scans every monthly partition the site has ever had, on every
 * journey a customer opens: the sort key leads on `site_id` and `object_id`, so
 * a bare `WHERE object_id = ...` reads the whole site. The bound is
 * `[from, to)`, taken from the range the caller is already viewing and widened
 * by the api on both sides.
 *
 * That is sound rather than convenient. The caller reached this endpoint from
 * the transactions list, so the charge's occurrence is inside the viewed range
 * by construction, and the api's one-day floor allowance absorbs the boundary
 * snapping the resolver applies. Refunds and disputes only ever FOLLOW their
 * charge, so nothing relevant can sit below the floor -- and the api extends the
 * ceiling to now before binding, so a refund issued after the viewed range still
 * appears. A charge id from outside the window returns nothing, which the route
 * surfaces as a 404: the honest answer to "show me a transaction that is not in
 * this range".
 */
const revenueOrderObjectsOperation = defineOperation({
  id: 'analytics.revenue_order_objects',
  summary: 'One charge and the refunds and disputes that point at it, oldest first.',
  requiresSiteScope: true,
  params: z
    .strictObject({
      site_id: z.uuid(),
      object_id: z.string().min(1).max(255),
      from: utcInstantSchema,
      to: utcInstantSchema,
    })
    .superRefine((value, ctx) => {
      const fromMs = Date.parse(value.from)
      const toMs = Date.parse(value.to)
      if (fromMs >= toMs) {
        ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
        return
      }
      if (toMs - fromMs > MAX_SPAN_HOUR_MS) {
        ctx.addIssue({
          code: 'custom',
          message: `journey object range span exceeds the ${MAX_SPAN_HOUR_MS}ms maximum`,
        })
      }
    }),
  sql: [
    'SELECT',
    '  cur.object_id AS object_id,',
    '  cur.object_kind AS object_kind,',
    '  cur.occurred_at AS occurred_at,',
    '  cur.status AS status,',
    '  cur.currency AS currency,',
    '  cur.gross_minor AS gross_minor,',
    '  cur.reporting_currency AS reporting_currency,',
    '  cur.reporting_gross_minor AS reporting_gross_minor,',
    '  cur.conversion_source AS conversion_source',
    'FROM (',
    '  SELECT',
    '    re.object_id AS object_id,',
    '    argMax(re.object_kind, re.version) AS object_kind,',
    "    toDateTime64(argMax(re.occurred_at, re.version), 3, 'UTC') AS occurred_at,",
    '    argMax(re.status, re.version) AS status,',
    '    argMax(re.currency, re.version) AS currency,',
    '    argMax(re.gross_minor, re.version) AS gross_minor,',
    '    argMax(re.reporting_currency, re.version) AS reporting_currency,',
    '    argMax(re.reporting_gross_minor, re.version) AS reporting_gross_minor,',
    '    argMax(re.conversion_source, re.version) AS conversion_source,',
    '    argMax(re.parent_object_id, re.version) AS parent_object_id',
    '  FROM revenue_events AS re',
    '  WHERE re.site_id = {site_id:UUID}',
    "    AND re.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "    AND re.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    '  GROUP BY re.site_id, re.provider, re.object_id',
    ') AS cur',
    'WHERE cur.object_id = {object_id:String} OR cur.parent_object_id = {object_id:String}',
    'ORDER BY cur.occurred_at ASC, cur.object_id ASC',
    'LIMIT 100',
  ].join('\n'),
  maxRows: 100,
  bind: (params) => ({
    site_id: params.site_id,
    object_id: params.object_id,
    from: toClickHouseInstant(params.from),
    to: toClickHouseInstant(params.to),
  }),
})

const revenueOperations: readonly QueryOperation[] = [
  defineRevenueTimeseries({
    id: 'analytics.revenue_timeseries_hour',
    summary: 'Revenue totals per timezone-local hour (revenue_15m).',
    table: 'revenue_15m',
    bucketExpr: bucketUtc('toStartOfHour(cur.bucket_start, {tz:String})'),
    source: '15m',
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 2_000,
  }),
  defineRevenueTimeseries({
    id: 'analytics.revenue_timeseries_day',
    summary: 'Revenue totals per UTC day (revenue_1d).',
    table: 'revenue_1d',
    bucketExpr: 'cur.bucket_start',
    source: '1d',
    alignment: 'day',
    withTimezone: false,
    maxRows: 4_000,
  }),
  // A non-UTC local day is composed from the atom rollup, exactly as the session
  // and additive families do, so a DST 23/25-hour day is correct rather than
  // shifted. Without it a non-UTC day chart would either be refused or answered
  // with UTC-day buckets wearing local labels.
  defineRevenueTimeseries({
    id: 'analytics.revenue_timeseries_day_local',
    summary: 'Revenue totals per timezone-local day, composed from revenue_15m.',
    table: 'revenue_15m',
    bucketExpr: bucketUtc('toStartOfDay(cur.bucket_start, {tz:String})'),
    source: '15m',
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 500,
  }),
  defineRevenueSummary({
    id: 'analytics.revenue_summary_hour',
    summary: 'Revenue totals over a range, read from revenue_15m.',
    table: 'revenue_15m',
    source: '15m',
    alignment: 'quarter',
  }),
  defineRevenueSummary({
    id: 'analytics.revenue_summary_day',
    summary: 'Revenue totals over a range, read from revenue_1d.',
    table: 'revenue_1d',
    source: '1d',
    alignment: 'day',
  }),
  revenueUnconvertedOperation,
  revenueTransactionsOperation,
  revenueTransactionJourneyOperation,
  revenueOrderObjectsOperation,
]

// ---------------------------------------------------------------------------
// Site cards — the whole account's list figures in one read (ADR-0080).
//
// The first operations in this registry that bind `{site_ids:Array(UUID)}`
// instead of `{site_id:UUID}`, and the invariant they widen is worth stating
// precisely, because "every operation binds site_id" was the sentence that made
// a cross-site read impossible:
//
//   every analytics operation binds `{site_id:UUID}` **or**
//   `{site_ids:Array(UUID)}`; the api passes only ids the caller is a member of,
//   so the gateway still never reads a site nobody bound.
//
// The boundary is unchanged — it is still the api that decides which sites a
// request may see, and still impossible here to read a site that was not named.
// What changes is arity, and the reason it changes is that `GET /v1/sites` is
// one screen: the alternative was N × `analytics.overview_day` plus N ×
// `analytics.timeseries_week_utc` per dashboard load, which is the frontend's
// N+1 moved one hop down rather than removed.
//
// Both read the UTC-day rollups only. That is a deliberate departure from
// ADR-0079 D5 ("every window is cut on the site's own zone"), written down in
// ADR-0080 D3: `toStartOfWeek` takes one constant timezone per statement, so a
// single query cannot cut each site's weeks on that site's own clock, and the
// 15m path that could is capped at MAX_SPAN_HOUR_DAYS (400 days) — far short of
// "all time". The card is an unlabelled, axis-less line, so the week boundary's
// zone is not a thing its reader can see; the all-time totals have no zone to be
// wrong about at all.
// ---------------------------------------------------------------------------

/**
 * Ceiling on how many sites one call may name.
 *
 * Not a tuning knob for the api's own cap (`SITES_CARD_MAX_SITES`) but the
 * structural one under it: `maxRows` is derived from it, so a request naming
 * more sites than this would come back capped by row truncation — a silently
 * short answer — rather than refused. Prod's largest account has 4 sites
 * (measured 2026-09-12), so this is headroom, not a limit anyone meets.
 */
const SITES_CARD_MAX_SITE_IDS = 100

/** Sparkline width, in whole ISO weeks — the span bound on the week branch. */
const SITES_CARD_MAX_WEEKS = 40

/** Rows one site can contribute: one per week in the window, plus its total. */
const SITES_CARD_ROWS_PER_SITE = SITES_CARD_MAX_WEEKS + 1

/**
 * `['<uuid>','<uuid>']` — the text form ClickHouse parses an `Array(UUID)`
 * parameter from.
 *
 * Still a bound parameter, not interpolation: this string is the *value* of
 * `param_site_ids`, never part of the statement, and ClickHouse parses it
 * server-side against the declared `Array(UUID)` type. The quoting is safe
 * because every element has already been through `z.uuid()`, which admits hex
 * digits and hyphens and nothing else — there is no element that could carry a
 * quote to close.
 */
function toClickHouseUuidArray(ids: readonly string[]): string {
  return `[${ids.map((id) => `'${id}'`).join(',')}]`
}

/** UTC Monday midnight — the ISO week boundary `toStartOfWeek(x, 1)` produces. */
function isUtcMondayAligned(instant: string): boolean {
  return isUtcDayAligned(instant) && new Date(instant).getUTCDay() === 1
}

const siteCardsParamsSchema = z
  .strictObject({
    site_ids: z
      .array(z.uuid())
      .min(1)
      .max(SITES_CARD_MAX_SITE_IDS)
      // De-duplicated rather than de-duplicating: a repeated id is a caller bug
      // (a membership list built twice), and answering it would return one
      // site's rows twice under a key the api then has to reconcile.
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'site_ids must not repeat an id',
      }),
    from: utcInstantSchema,
    to: utcInstantSchema,
  })
  .superRefine((value, ctx) => {
    const fromMs = Date.parse(value.from)
    const toMs = Date.parse(value.to)
    if (fromMs >= toMs) {
      ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
      return
    }
    // Monday-aligned, not merely day-aligned. The week branch groups with
    // `toStartOfWeek(…, 1)`, so an endpoint mid-week would produce a first or
    // last bucket holding a fraction of a week beside six whole ones — a
    // sparkline point that is short for a reason no reader can see. Refusing
    // the range is the only way to keep every plotted point the same width.
    if (!isUtcMondayAligned(value.from) || !isUtcMondayAligned(value.to)) {
      ctx.addIssue({
        code: 'custom',
        message: 'range endpoints must be UTC Monday midnights (ISO week boundaries)',
      })
    }
    if (toMs - fromMs > SITES_CARD_MAX_WEEKS * 7 * MS_PER_DAY) {
      ctx.addIssue({
        code: 'custom',
        message: `range span exceeds this operation's ${SITES_CARD_MAX_WEEKS}-week maximum`,
      })
    }
  })

/**
 * Per-site all-time totals and the trailing weekly series, in one statement.
 *
 * Two branches of a `UNION ALL` with *different* filters, which is the whole
 * point of unioning them rather than deriving one from the other:
 *
 *   * the total branch has **no lower bound** — "all time" read literally, the
 *     same span `analytics.overview_day` covers when the dashboard anchors its
 *     widest interval at `created_at`;
 *   * the week branch is bounded to `[from, to)`, the trailing 40 ISO weeks.
 *
 * And a total is emphatically **not** the sum of the weeks. `visitors` is a
 * `uniqMerge` of the stored states (ADR-0036: filtered to the page-view
 * population, so `visitors <= pageviews` holds on every row), and a person who
 * visited in two different weeks is one visitor in the total and one in each of
 * those two weeks. Summing the weekly numbers would over-count them; the
 * migration suite pins exactly that case against a live ClickHouse.
 *
 * `is_total` rather than a nullable `week`: the branches of a `UNION ALL` have
 * to agree on column types, and a discriminator the api reads is clearer at both
 * ends than widening the week column to `Nullable` so one branch can put a
 * `NULL` in it.
 */
const sitesAllTimeOperation = defineOperation({
  id: 'analytics.sites_all_time',
  summary:
    'All-time pageviews and unique visitors per site, plus the trailing ISO-week series (metrics_1d, UTC).',
  requiresSiteScope: true,
  params: siteCardsParamsSchema,
  sql: [
    'SELECT',
    '  t.site_id AS site_id,',
    '  toUInt8(0) AS is_total,',
    "  toDateTime64(toStartOfWeek(t.bucket_start, 1), 3, 'UTC') AS week,",
    "  sumIf(t.events, t.event_type = 'page_view') AS pageviews,",
    "  uniqMergeIf(t.visitors, t.event_type = 'page_view') AS visitors",
    'FROM metrics_1d AS t',
    'WHERE t.site_id IN {site_ids:Array(UUID)}',
    "  AND t.bucket_start >= toDateTime64({from:String}, 3, 'UTC')",
    "  AND t.bucket_start < toDateTime64({to:String}, 3, 'UTC')",
    'GROUP BY t.site_id, week',
    'UNION ALL',
    'SELECT',
    '  t.site_id AS site_id,',
    '  toUInt8(1) AS is_total,',
    // A constant the api never reads, present only so both branches project the
    // same column type. The discriminator is what says this row has no week.
    "  toDateTime64(0, 3, 'UTC') AS week,",
    "  sumIf(t.events, t.event_type = 'page_view') AS pageviews,",
    "  uniqMergeIf(t.visitors, t.event_type = 'page_view') AS visitors",
    'FROM metrics_1d AS t',
    'WHERE t.site_id IN {site_ids:Array(UUID)}',
    "  AND t.bucket_start < toDateTime64({to:String}, 3, 'UTC')",
    'GROUP BY t.site_id',
  ].join('\n'),
  maxRows: SITES_CARD_MAX_SITE_IDS * SITES_CARD_ROWS_PER_SITE,
  // The api caches this one, keyed by the caller's membership set and held for
  // minutes rather than the gateway cache's seconds (ADR-0080 D5). Caching it
  // here as well would put two TTLs on one answer, the shorter of which decides
  // nothing.
  cacheable: false,
  bind: (params) => ({
    site_ids: toClickHouseUuidArray(params.site_ids),
    from: toClickHouseInstant(params.from),
    to: toClickHouseInstant(params.to),
  }),
})

/**
 * All-time net revenue per site, in each site's own reporting currency.
 *
 * `revenue_1d` is a `ReplacingMergeTree(generation)`, so every read takes the
 * current generation of each bucket with `argMax(…, generation)` before summing
 * — never `FINAL`, and never a bare `sum` over the table, which would add every
 * superseded generation of every recomputed bucket (the D-212 read rule).
 *
 * There is no `currency` column and there must not be one: the worker converts
 * into the site's reporting currency when it writes the rollup (ADR-0033 D2c),
 * so the label belongs to `sites.reporting_currency` and the api attaches it.
 * The api also calls this only for sites that actually have a revenue credential
 * row — a site with no provider connected is not a zero, it is a different
 * answer, and ADR-0080 D4 keeps the two apart above this query.
 */
const sitesAllTimeRevenueOperation = defineOperation({
  id: 'analytics.sites_all_time_revenue',
  summary: 'All-time net revenue per site, in the site reporting currency (revenue_1d).',
  requiresSiteScope: true,
  params: siteCardsParamsSchema,
  sql: [
    'SELECT',
    '  cur.site_id AS site_id,',
    '  sum(cur.net_minor) AS net_minor',
    'FROM (',
    '  SELECT',
    '    rr.site_id AS site_id,',
    '    argMax(rr.net_minor, rr.generation) AS net_minor',
    '  FROM revenue_1d AS rr',
    '  WHERE rr.site_id IN {site_ids:Array(UUID)}',
    "    AND rr.bucket_start < toDateTime64({to:String}, 3, 'UTC')",
    '  GROUP BY rr.site_id, rr.bucket_start',
    ') AS cur',
    'GROUP BY cur.site_id',
  ].join('\n'),
  maxRows: SITES_CARD_MAX_SITE_IDS,
  cacheable: false,
  // `from` is validated and deliberately not bound: this half is all-time only,
  // and `defineOperation` rejects a bound value the statement ignores. Sharing
  // the schema is what keeps one window definition for both halves of the card.
  bind: (params) => ({
    site_ids: toClickHouseUuidArray(params.site_ids),
    to: toClickHouseInstant(params.to),
  }),
})

const siteCardOperations: readonly QueryOperation[] = [
  sitesAllTimeOperation,
  sitesAllTimeRevenueOperation,
]

// ---------------------------------------------------------------------------
// Freshness watermark (docs snapshot 02 §18: analytics responses carry
// freshness). The latest occurred_at bucket a site has rolled up, read from the
// finest rollup, plus a bucket count so "no data" is distinguishable from
// "stale". Cheap: site_id is the ORDER BY prefix, and only bucket_start is read.
// ---------------------------------------------------------------------------

const freshnessOperation = defineOperation({
  id: 'analytics.freshness',
  summary: 'Latest rolled-up occurred_at watermark and bucket count for a site.',
  requiresSiteScope: true,
  params: z.strictObject({ site_id: z.uuid() }),
  sql: [
    'SELECT',
    '  max(bucket_start) AS watermark,',
    '  count() AS buckets',
    'FROM metrics_1m',
    'WHERE site_id = {site_id:UUID}',
  ].join('\n'),
  maxRows: 1,
  cacheable: false,
  bind: (params) => ({ site_id: params.site_id }),
})

// ---------------------------------------------------------------------------
// Health (Milestone 1). Kept: it is the liveness of the gateway → private
// ClickHouse hop with the read-only credential, reads no table, and takes no
// parameters. `analytics.site_range_probe` is retired — the real rollup
// operations above exercise the same contract it stood in for (site-scoped,
// typed half-open range, bound-parameter-only) against actual tables, so the
// echo operation no longer proves anything the registry does not.
// ---------------------------------------------------------------------------

export const clickhouseRoundtripOperation = defineOperation({
  id: 'health.clickhouse_roundtrip',
  summary: 'Round-trips a constant through private ClickHouse using the read-only user.',
  requiresSiteScope: false,
  params: z.strictObject({}),
  sql: 'SELECT 1 AS ok',
  maxRows: 1,
  cacheable: false,
  bind: () => ({}),
})

// ---------------------------------------------------------------------------
// Filtered reads (ADR-0075, D-F1 … D-F5).
//
// The third family that reads `events_raw`, and it earns the exception the way
// the funnel and the recent-visitor family earn theirs, which is the only way it
// may be earned here: a hard site filter, a span capped far below the rollup
// reports', a row cap, and an aggregate that returns a bounded breakdown rather
// than rows of events.
//
// ## Why a filtered read cannot use a rollup at all
//
// Every rollup has already aggregated away the thing a filter selects on.
// `pages_15m` is `(site, bucket, page_path)`; there is no session in it and no
// referrer either. `sources_15m` carries a referrer but has no page. A filtered
// pages report is "the pages viewed by sessions that came from X", and no
// pre-aggregated table has both halves. So a filter is answered from the facts —
// and D-F4 is what keeps that cost off everybody else: these operations are
// ADDITIONAL, the unfiltered ones are untouched, and a dashboard with no chips
// issues byte-identically the same queries it issued before this family existed.
//
// ## The predicate, and why it is still a constant statement (D-F3)
//
// No SQL reaches the gateway from the api and no dimension name is ever spliced.
// The statement carries a fixed block — one conjunct per dimension in
// `FILTER_DIMENSIONS`, generated at module load — of the shape
//
//     AND ({f_country_on:UInt8} = 0 OR has(<values>, cur.country))
//
// so an inactive dimension is switched off by a BOUND VALUE rather than by a
// different statement. Every placeholder is bound on every call, which is what
// `defineOperation`'s two-directional check demands, and adding a fifth
// dimension is a data change to `FILTER_DIMENSIONS` plus a column on the fact
// table — never an edit to a statement.
//
// The values arrive as one JSON string per dimension and are read back with
// `JSONExtract(…, 'Array(String)')`. A JSON string rather than a ClickHouse
// `Array(String)` parameter because the HTTP reader stringifies every bound
// value, and hand-rolling ClickHouse's array literal escaping for a city called
// `N'Djamena` is a bug waiting to be written. `JSON.stringify` already has that
// rule and both ends already agree on it.
//
// ## The join, and the trap it steps around
//
// `session_facts_versions.session_id` is the sessionizer's own hash of
// (site, earliest event id) — migration 0013 — and it is NOT what `events_raw`
// carries. The raw table's `session_id` is the site-scoped HMAC of the client
// hint, which the fact table stores as `session_hint`. Joining on the
// same-named column returns nothing at all, silently, which is the worst
// possible failure for a filter: an empty report reads as "no traffic from that
// source" rather than as a bug.
//
// So the join is `(er.site_id, er.session_id) IN (SELECT site_id, session_hint …)`.
//
// **`anonymous_id` is deliberately NOT part of the key**, and this is a
// departure worth stating. The fact's `anonymous_id` is the ENTRY event's, and
// the D-102 identity bridge exists precisely because one visit can span two
// anonymous ids — a UTC-midnight rotation, a VPN hop, a mobile carrier's CGNAT.
// Every event after the rotation carries the second id, so a key that included
// the anonymous id would drop the tail of every bridged session from every
// filtered report, on mobile traffic above all. The hint alone is safe as an
// identity: it is minted randomly per browser tab and hashed per site, so two
// visitors cannot carry the same one — the sessionizer's own header says so, and
// it is the reason the bridge requires a shared hint in the first place.
//
// The residual imprecision is the other direction and is stated rather than
// hidden: one hint can outlive one session (a tab left open across a 30-minute
// gap produces two canonical sessions under one hint), so when only one of them
// matches the filter the other's events are counted too. It is bounded by the
// range filter and by the 24-hour session cap, and it is smaller than the error
// that including `anonymous_id` would have caused.
//
// ## The session window
//
// A session that began before `from` can own events inside the range, so the
// subquery scans `[from - session cap, to)` rather than `[from, to)`. The cap is
// ADR-0018's 24 hours, which makes the widening exact rather than generous: a
// session containing an event at `t` cannot have started before `t - 24h`.
//
// ## Events with no session hint
//
// The collector writes `session_id: null` when the client sent none — a
// server-side SDK call, a widget write, any non-tracker producer. Such an event
// belongs to no canonical session, so no session attribute can select it, and it
// is outside every filtered read BY CONSTRUCTION rather than by omission. That
// is the honest reading of D-F1: a filter selects sessions, and an event with no
// session is in none of them. It is stated in the ADR and in the frontend note
// so a filtered total that sits below the unfiltered one is read as the rule it
// is.
//
// ## What is imported is not here
//
// A staged provider day carries no session, so there is nothing on the imported
// side of the cutover for a session-scoped filter to include or exclude. A
// filtered read is live-only by construction, binds no cutover and no run id,
// and the api marks the response's `data_sources` accordingly.
// ---------------------------------------------------------------------------

/**
 * Longest span a filtered read may scan.
 *
 * The funnel's cap, deliberately reused rather than invented: it is the bound
 * this cluster has actually been operated at for a raw, site-scoped, aggregate
 * read, and it is far below the rollup reports' 400-day and 3660-day ceilings,
 * which is what D-F5 asks for. A longer filtered range is refused by name in the
 * api before a query is issued.
 */
const FILTERED_MAX_SPAN_MS = 92 * MS_PER_DAY

/** ADR-0018's session cap: how far before `from` a session could have begun. */
const SESSION_CAP_MS = 24 * MS_PER_HOUR

/** Bounded like the funnel: one row per key, and a hard ceiling on the keys. */
const FILTERED_TOP_N_MAX = 500

/**
 * The fixed predicate block: one conjunct per dimension, generated at module
 * load from the domain's own list so the statement stays a constant.
 */
function filterConjuncts(alias: string): string {
  return FILTER_DIMENSIONS.map(
    (dimension) =>
      `    AND ({f_${dimension}_on:UInt8} = 0 OR ` +
      `has(JSONExtract({f_${dimension}:String}, 'Array(String)'), toString(${alias}.${dimension})))`,
  ).join('\n')
}

/**
 * The session-selection subquery, indented to sit inside an `IN (...)`.
 *
 * `argMax` over `version` per `(site_id, session_id)` FIRST and `retracted = 0`
 * only afterwards, which is migration 0013's read contract and not a style
 * choice: filtering `retracted = 0` before the version selection discards the
 * tombstone and resurrects the stale version underneath it, so a retracted
 * session would be counted — the exact bug the tombstone exists to prevent.
 */
const FILTER_SESSION_SUBQUERY = [
  '  SELECT',
  '    cur.site_id AS site_id,',
  // **Every** hint the session carried, not just its entry's (migration 0023).
  // The sessionizer partitions by resolved identity rather than by hint, so two
  // tabs of one anonymous visitor are one session with two hints — and on a
  // production fortnight the entry hint alone found 82% of the page views while
  // 99% of them had a session under the same anonymous id. `arrayJoin` over the
  // stored list closes that gap without the range join the alternative needs.
  //
  // A session that carried no hint expands to no rows here, which is the honest
  // answer rather than an omission: it cannot be joined to its events at all,
  // and a row with an empty hint would match every hintless event on the site.
  "    arrayJoin(arrayFilter(hint -> hint != '', cur.session_hints)) AS session_hint",
  '  FROM (',
  '    SELECT',
  '      sfv.site_id AS site_id,',
  '      argMax(sfv.session_hints, sfv.version) AS session_hints,',
  '      argMax(sfv.referrer_domain, sfv.version) AS referrer_domain,',
  '      argMax(sfv.country, sfv.version) AS country,',
  '      argMax(sfv.city, sfv.version) AS city,',
  '      argMax(sfv.device_type, sfv.version) AS device_type,',
  '      argMax(sfv.retracted, sfv.version) AS retracted',
  '    FROM session_facts_versions AS sfv',
  '    WHERE sfv.site_id = {site_id:UUID}',
  "      AND sfv.session_start >= toDateTime64({session_from:String}, 3, 'UTC')",
  "      AND sfv.session_start <  toDateTime64({to:String}, 3, 'UTC')",
  '    GROUP BY sfv.site_id, sfv.session_id',
  '  ) AS cur',
  '  WHERE cur.retracted = 0',
  filterConjuncts('cur'),
].join('\n')

/** The events-side WHERE every filtered read shares. */
function filteredEventFilter(pageviewsOnly: boolean): string {
  return [
    'FROM events_raw AS er',
    'WHERE er.site_id = {site_id:UUID}',
    "  AND er.occurred_at >= toDateTime64({from:String}, 3, 'UTC')",
    "  AND er.occurred_at <  toDateTime64({to:String}, 3, 'UTC')",
    // Every breakdown here mirrors its rollup's own population exactly
    // (migrations 0007-0010 all read `WHERE type = 'page_view'`), so a filtered
    // row and an unfiltered row of the same report are the same measure.
    ...(pageviewsOnly ? ["  AND er.type = 'page_view'"] : []),
    "  AND er.session_id != ''",
    '  AND (er.site_id, er.session_id) IN (',
    FILTER_SESSION_SUBQUERY,
    '  )',
  ].join('\n')
}

/**
 * The unique-visitor expression, spelled exactly as every rollup spells it.
 *
 * `uniqState(if(user_id != '', user_id, anonymous_id))` is what migrations
 * 0006-0010 store, so this is the same population counted the same way — the
 * point being that switching a filter on must not also switch the definition of
 * a visitor.
 */
const FILTERED_VISITOR_EXPR = "if(er.user_id != '', er.user_id, er.anonymous_id)"

/** The parameters every filtered operation takes, beyond its own extras. */
function filteredParamsSchema(options: {
  maxRangeMs: number
  alignment: RangeAlignment
  withTimezone: boolean
  withLimit: boolean
}) {
  const shape: Record<string, z.ZodTypeAny> = {
    site_id: z.uuid(),
    from: utcInstantSchema,
    to: utcInstantSchema,
    filters: z
      .array(
        z.strictObject({
          dimension: z.enum(FILTER_DIMENSIONS),
          operator: z.enum(FILTER_OPERATORS),
          values: z.array(z.string().max(MAX_FILTER_VALUE_LENGTH)).min(1).max(MAX_FILTER_VALUES),
        }),
      )
      .min(1)
      .max(MAX_FILTER_CLAUSES),
  }
  if (options.withTimezone) shape['timezone'] = timezoneSchema
  if (options.withLimit) {
    shape['limit'] = z.number().int().min(1).max(FILTERED_TOP_N_MAX).default(TOP_N_DEFAULT)
  }

  return z
    .strictObject(shape)
    .superRefine((value: Record<string, unknown>, ctx: z.RefinementCtx) => {
      const from = value['from'] as string
      const to = value['to'] as string
      const fromMs = Date.parse(from)
      const toMs = Date.parse(to)

      if (fromMs >= toMs) {
        ctx.addIssue({ code: 'custom', message: 'range must be half-open with from < to' })
        return
      }
      if (toMs - fromMs > options.maxRangeMs) {
        ctx.addIssue({
          code: 'custom',
          message: `filtered range span exceeds this operation's ${options.maxRangeMs}ms maximum`,
        })
      }
      if (!isAligned(options.alignment, from) || !isAligned(options.alignment, to)) {
        ctx.addIssue({
          code: 'custom',
          message: `range endpoints must align to a UTC ${ALIGNMENT_LABEL[options.alignment]} boundary`,
        })
      }
      // D-F4, asserted structurally: an EMPTY filter set may not reach this
      // family at all. The unfiltered read is a different, cheaper operation on
      // a rollup, and a caller that sent no chips must never be routed here —
      // so the operation refuses rather than trusting the router.
      const filters = value['filters'] as { values: readonly string[] }[]
      if (!filters.some((filter) => filter.values.length > 0)) {
        ctx.addIssue({
          code: 'custom',
          message: 'a filtered operation requires at least one filter value; use the rollup read',
        })
      }
    })
}

/** Binds the fixed per-dimension flag/value pair for every dimension. */
function bindFilters(filters: readonly AnalyticsFilter[]): Record<string, QueryParameterValue> {
  const bound: Record<string, QueryParameterValue> = {}
  for (const dimension of FILTER_DIMENSIONS) {
    const values = filterValuesFor(filters, dimension)
    bound[`f_${dimension}_on`] = values.length > 0 ? 1 : 0
    bound[`f_${dimension}`] = JSON.stringify(values)
  }
  return bound
}

/** The instant the session subquery opens at: `from` minus the session cap. */
function sessionWindowStart(from: string): string {
  return toClickHouseInstant(new Date(Date.parse(from) - SESSION_CAP_MS).toISOString())
}

function defineFilteredReport(definition: {
  id: string
  source: RollupResolution
  alignment: RangeAlignment
  dimensions: readonly string[]
  orderBy: string
  summary: string
}): QueryOperation {
  const selectList = [
    ...definition.dimensions.map((column) => `  er.${column} AS ${column},`),
    '  count() AS views,',
    `  uniqExact(${FILTERED_VISITOR_EXPR}) AS visitors`,
  ]
  const sql = [
    'SELECT',
    ...selectList,
    filteredEventFilter(true),
    `GROUP BY ${definition.dimensions.join(', ')}`,
    `ORDER BY ${definition.orderBy} DESC`,
    'LIMIT {limit:UInt32}',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    allowRawEvents: true,
    params: filteredParamsSchema({
      maxRangeMs: Math.min(maxRangeFor[definition.source], FILTERED_MAX_SPAN_MS),
      alignment: definition.alignment,
      withTimezone: false,
      withLimit: true,
    }),
    sql,
    maxRows: FILTERED_TOP_N_MAX,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      session_from: sessionWindowStart(params['from'] as string),
      limit: params['limit'] as number,
      ...bindFilters(params['filters'] as readonly AnalyticsFilter[]),
    }),
  })
}

const FILTERED_REPORT_SHAPES: readonly {
  slug: string
  dimensions: readonly string[]
  summary: string
}[] = [
  { slug: 'pages', dimensions: ['page_path'], summary: 'Top pages' },
  {
    slug: 'sources',
    dimensions: ['referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign'],
    summary: 'Top acquisition sources',
  },
  { slug: 'geography', dimensions: ['country', 'city'], summary: 'Top countries and cities' },
  {
    slug: 'devices',
    dimensions: ['device_type', 'browser', 'os'],
    summary: 'Top device/browser/OS combinations',
  },
]

const filteredReportOperations: readonly QueryOperation[] = FILTERED_REPORT_SHAPES.flatMap(
  (shape) => [
    defineFilteredReport({
      id: `analytics.filtered_${shape.slug}_hour`,
      source: '15m',
      alignment: 'quarter',
      dimensions: shape.dimensions,
      orderBy: 'views',
      summary: `${shape.summary} for sessions matching a filter set. Quarter-hour-aligned.`,
    }),
    defineFilteredReport({
      id: `analytics.filtered_${shape.slug}_day`,
      source: '1d',
      alignment: 'day',
      dimensions: shape.dimensions,
      orderBy: 'views',
      summary: `${shape.summary} for sessions matching a filter set. UTC-day-aligned.`,
    }),
  ],
)

function defineFilteredOverview(definition: {
  id: string
  source: RollupResolution
  alignment: RangeAlignment
  summary: string
}): QueryOperation {
  const sql = [
    'SELECT',
    '  count() AS events,',
    "  countIf(er.type = 'page_view') AS pageviews,",
    '  countIf(er.billable = 1) AS billable_events,',
    // The `OverviewTotals.visitors` contract sentence (ADR-0036): the range's
    // visitors are the distinct identities with at least one page view in it,
    // the population `pageviews` counts. Same rule as the rollup's
    // `uniqMergeIf(t.visitors, t.event_type = 'page_view')`.
    `  uniqExactIf(${FILTERED_VISITOR_EXPR}, er.type = 'page_view') AS visitors`,
    filteredEventFilter(false),
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    allowRawEvents: true,
    params: filteredParamsSchema({
      maxRangeMs: Math.min(maxRangeFor[definition.source], FILTERED_MAX_SPAN_MS),
      alignment: definition.alignment,
      withTimezone: false,
      withLimit: false,
    }),
    sql,
    maxRows: 1,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      session_from: sessionWindowStart(params['from'] as string),
      ...bindFilters(params['filters'] as readonly AnalyticsFilter[]),
    }),
  })
}

function defineFilteredTimeseries(definition: {
  id: string
  source: RollupResolution
  bucketExpr: string
  alignment: RangeAlignment
  withTimezone: boolean
  maxRows: number
  summary: string
}): QueryOperation {
  const sql = [
    'SELECT',
    `  ${definition.bucketExpr} AS bucket,`,
    '  count() AS events,',
    "  countIf(er.type = 'page_view') AS pageviews,",
    `  uniqExactIf(${FILTERED_VISITOR_EXPR}, er.type = 'page_view') AS visitors`,
    filteredEventFilter(false),
    'GROUP BY bucket',
    'ORDER BY bucket',
  ].join('\n')

  return defineOperation({
    id: definition.id,
    summary: definition.summary,
    requiresSiteScope: true,
    allowRawEvents: true,
    params: filteredParamsSchema({
      maxRangeMs: Math.min(maxRangeFor[definition.source], FILTERED_MAX_SPAN_MS),
      alignment: definition.alignment,
      withTimezone: definition.withTimezone,
      withLimit: false,
    }),
    sql,
    maxRows: definition.maxRows,
    bind: (params: Record<string, unknown>) => ({
      site_id: params['site_id'] as string,
      from: toClickHouseInstant(params['from'] as string),
      to: toClickHouseInstant(params['to'] as string),
      session_from: sessionWindowStart(params['from'] as string),
      ...(definition.withTimezone ? { tz: params['timezone'] as string } : {}),
      ...bindFilters(params['filters'] as readonly AnalyticsFilter[]),
    }),
  })
}

/**
 * The filtered chart, one operation per grain, named to mirror the unfiltered
 * family exactly so the api's grain decision is the same decision on both paths.
 *
 * Read straight off `occurred_at` rather than off a stored bucket, so the
 * timezone-local grouping is done once here instead of being composed from hour
 * buckets — which also means the UTC-day variants exist only to keep the naming
 * parallel, and are byte-identical in shape to the local ones with `'UTC'`
 * bound in place of the zone.
 */
const filteredTimeseriesOperations: readonly QueryOperation[] = [
  defineFilteredTimeseries({
    id: 'analytics.filtered_timeseries_minute',
    source: '1m',
    bucketExpr: bucketUtc('toStartOfMinute(er.occurred_at, {tz:String})'),
    alignment: 'minute',
    withTimezone: true,
    maxRows: 3_000,
    summary: 'Filtered events, pageviews and visitors per timezone-local minute.',
  }),
  defineFilteredTimeseries({
    id: 'analytics.filtered_timeseries_hour',
    source: '15m',
    bucketExpr: bucketUtc('toStartOfHour(er.occurred_at, {tz:String})'),
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 1_000,
    summary: 'Filtered events, pageviews and visitors per timezone-local hour.',
  }),
  defineFilteredTimeseries({
    id: 'analytics.filtered_timeseries_day',
    source: '15m',
    bucketExpr: bucketUtc('toStartOfDay(er.occurred_at, {tz:String})'),
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 500,
    summary: 'Filtered events, pageviews and visitors per timezone-local day.',
  }),
  defineFilteredTimeseries({
    id: 'analytics.filtered_timeseries_day_utc',
    source: '1d',
    bucketExpr: bucketUtc('toStartOfDay(er.occurred_at)'),
    alignment: 'day',
    withTimezone: false,
    maxRows: 500,
    summary: 'Filtered events, pageviews and visitors per UTC day.',
  }),
  defineFilteredTimeseries({
    id: 'analytics.filtered_timeseries_week',
    source: '15m',
    bucketExpr: bucketUtc('toDateTime(toStartOfWeek(er.occurred_at, 1, {tz:String}), {tz:String})'),
    alignment: 'quarter',
    withTimezone: true,
    maxRows: 600,
    summary: 'Filtered events, pageviews and visitors per timezone-local ISO week.',
  }),
  defineFilteredTimeseries({
    id: 'analytics.filtered_timeseries_week_utc',
    source: '1d',
    bucketExpr: "toDateTime64(toStartOfWeek(er.occurred_at, 1), 3, 'UTC')",
    alignment: 'day',
    withTimezone: false,
    maxRows: 600,
    summary: 'Filtered events, pageviews and visitors per ISO week in UTC.',
  }),
]

const filteredOverviewOperations: readonly QueryOperation[] = [
  defineFilteredOverview({
    id: 'analytics.filtered_overview_hour',
    source: '15m',
    alignment: 'quarter',
    summary:
      'Filtered range totals — events, pageviews, billable events, visitors. Quarter-hour-aligned.',
  }),
  defineFilteredOverview({
    id: 'analytics.filtered_overview_day',
    source: '1d',
    alignment: 'day',
    summary: 'Filtered range totals. UTC-day-aligned.',
  }),
]

/**
 * The filtered twin of the entry/exit decoration.
 *
 * It exists so a filtered pages screen is coherent rather than half-filtered:
 * without it the `views` column would answer "for the filtered sessions" while
 * the `entrances` beside it answered "for all of them", on one row, with nothing
 * to tell them apart. Two numbers in one table that quietly mean different
 * things is the failure mode this whole family is built to avoid.
 */
const filteredPageSessionOperations: readonly QueryOperation[] = [
  definePageSessions({
    id: 'analytics.filtered_page_sessions_hour',
    source: '15m',
    alignment: 'quarter',
    filtered: true,
    summary:
      'Entrances, exits, bounces and sessions per page path for sessions matching a filter set. Quarter-hour-aligned.',
  }),
  definePageSessions({
    id: 'analytics.filtered_page_sessions_day',
    source: '1d',
    alignment: 'day',
    filtered: true,
    summary:
      'Entrances, exits, bounces and sessions per page path for sessions matching a filter set. UTC-day-aligned.',
  }),
]

const filteredOperations: readonly QueryOperation[] = [
  ...filteredOverviewOperations,
  ...filteredTimeseriesOperations,
  ...filteredReportOperations,
  ...filteredPageSessionOperations,
]

const OPERATIONS: readonly QueryOperation[] = [
  clickhouseRoundtripOperation,
  ...timeseriesOperations,
  ...overviewOperations,
  ...reportOperations,
  ...customEventSampleOperations,
  ...importedReportOperations,
  ...sessionOperations,
  ...pageSessionOperations,
  ...funnelOperations,
  ...recentVisitorOperations,
  ...filteredOperations,
  ...revenueOperations,
  ...siteCardOperations,
  freshnessOperation,
]

export const QUERY_OPERATIONS: ReadonlyMap<string, QueryOperation> = new Map(
  OPERATIONS.map((operation) => [operation.id, operation]),
)

export function findOperation(id: string): QueryOperation | undefined {
  return QUERY_OPERATIONS.get(id)
}

export const queryRequestSchema = z.strictObject({
  operation: z.string().min(1).max(64),
  // Left as `unknown` on purpose: the operation's own schema is the only thing
  // allowed to interpret it, and it does so after the ID is known to be allowed.
  params: z.unknown().optional(),
  /**
   * The caller's cache generation for this site (ADR-0030, decision 6).
   *
   * The api sources it from `sites.config_version`, which every lifecycle
   * transition bumps, and the gateway mixes it into the cache key — so cached
   * entries for the previous version become unreachable garbage the LRU evicts,
   * without an invalidation channel that could only ever reach one instance.
   *
   * It is a *cache* input and nothing else: it is never bound into SQL, never
   * reaches an operation's parameter schema, and an absent value behaves exactly
   * as version 0 did. Optional because this schema is a `strictObject` and the
   * deploy order is gateway-before-api — the new gateway must accept a body from
   * the old api, which never sends it.
   */
  cache_epoch: z.number().int().nonnegative().optional(),
})

export type QueryRequest = z.infer<typeof queryRequestSchema>
