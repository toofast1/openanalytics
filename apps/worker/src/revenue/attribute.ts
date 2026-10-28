import type {
  RevenueAttributionRow,
  RevenueAttributionsStore,
  RevenueEventsStore,
  RevenueRollupsStore,
} from '@openanalytics/clickhouse'
import {
  REVENUE_ATTRIBUTION_WINDOW_DAYS,
  externalUserIdHash,
  planRevenueAttributions,
  type AttributableCharge,
  type ComputedRevenueAttribution,
  type ConversionSignal,
  type IdentityKey,
  type RevenueMatchedVia,
  type SessionTouchpoint,
  type StoredRevenueAttribution,
} from '@openanalytics/domain'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  advanceRevenueAttributionWatermark,
  advanceRevenueRollupRecompute,
  claimRevenueAttributionSite,
  isSiteFullyProjected,
  readOldestUnprojectedRevenueObjectUpdate,
  listSitesForRevenueAttribution,
  markRevenueRollupRecompute,
  readOldestChangedRevenueChargeOccurrence,
  readOldestChangedRevenueObjectOccurrence,
  readOldestRevenueAttributionWatermark,
  readRevenueMatchHintsByOrder,
  readSiteIngestSettings,
  releaseRevenueAttributionSite,
  type Database,
  type RevenueMatchHintRow,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import { toRollupFact } from './rollup-plan.ts'
import { revenueRecomputeChunk, revenueRollupRange, rollUpRevenueSite } from './rollup.ts'

/**
 * The attribution job (ADR-0033, D6; ClickHouse migration 0017, Postgres 0036).
 * Milestone 12 Checkpoint 4.
 *
 * The session finalizer's idiom, applied to a different fact: per-site
 * discovery, a Postgres lease and watermark, a **pure** planner
 * (`planRevenueAttributions` in `@openanalytics/domain`), fingerprint-compared
 * versioned writes. Nothing here decides what an attribution says; it fetches
 * the planner's inputs, hashes the two identity signals the planner is not
 * allowed to hold a secret for, and makes the answer durable.
 *
 * ============================================================================
 * THE HORIZON RULE — state it once, here, and test it
 * ============================================================================
 *
 * An attribution is a function of data that arrives AFTER the charge it
 * describes. Three inputs can move under a finished answer:
 *
 *   * a `conversion` event, up to 24 h late (D-016);
 *   * the session that is its touchpoint, which is not final until inactivity
 *     (30 min) plus that same lateness has passed;
 *   * a checkout hint, whose `checkout.session.completed` delivery can be
 *     retried by the provider long after the charge landed.
 *
 * A watermark that meant "everything before here is finished" would therefore be
 * a lie. So `computed_through` means "the instant whose inputs this site has
 * been computed against", and **every run re-reads a rolling window of charges
 * rather than only new ones**:
 *
 *     horizon = attribution window (30 d) + lateness (24 h)
 *     from    = min( now - horizon,          -- the rolling re-read
 *                    computed_through,       -- epoch on a fresh site
 *                    oldest charge head changed since computed_through )
 *     to      = now + 1 ms                   -- half-open, so a charge stamped
 *                                            -- exactly now is included
 *
 * Each of the three terms is load-bearing:
 *
 *   1. `now - horizon` is what makes a late conversion event flip a charge from
 *      `none` to `exact`. Without it a charge attributed once would keep its
 *      first answer forever.
 *   2. `computed_through` is the epoch on a site that has never run, which is
 *      what makes the first pass cover a 90-day backfill (D2e) even though the
 *      rolling window is 31 days.
 *   3. The oldest *changed* head is the escape hatch for a backfill that lands
 *      AFTER the watermark has already moved — connect, one attribution pass,
 *      then the backfill completes. Without this term every charge older than
 *      the rolling window would sit unattributed forever, because nothing would
 *      ever pull the horizon back to it.
 *
 * Advancing to `now` (rather than to `now - lateness`) is deliberate and is safe
 * precisely because the horizon is rolling: the watermark is not a completeness
 * claim, so nothing depends on it being conservative. What it does buy is a
 * discovery predicate that goes quiet — a site with no new heads and no new
 * hints is re-run only when the refresh interval elapses.
 *
 * **What this rule permanently misses, named rather than left to be discovered:**
 * a charge older than `window + lateness` whose touchpoint session finalizes
 * late and whose object head never moves again. Term 1 no longer reaches it,
 * term 2 is long past, and term 3 needs the head to change. Its attribution
 * keeps whatever answer the last pass that could see it produced.
 *
 * It is unreachable outside a deep backfill, and that case is exactly what term 3
 * covers: a charge more than 31 days old is either historical (its sessions were
 * finalized weeks ago — the finalizer's own watermark can only lag ~48.5 hours)
 * or it arrived through a backfill, which moves the head and pulls the horizon
 * back to it. The gap needs a charge that is simultaneously old, already
 * projected, and still waiting on a session finalization that is a month
 * overdue — which the finalizer's bound makes impossible. Accepted, and the
 * alternative (never letting the floor advance) would mean re-reading a site's
 * entire revenue history 96 times a day forever.
 *
 * ============================================================================
 * THE SITE'S OWN SWITCH — attribution is opt-in, the money is not
 * ============================================================================
 *
 * A site with `attributed_revenue` off is rolled up and never attributed. The
 * check is one line in `attributeSite`, deliberately above every
 * attribution-only read and below the rollup closure, and the reasoning is with
 * it. In one sentence: the switch means "is this visitor linked to this
 * payment", so it has to be enforced where the linking happens, and two of D6's
 * three signals never pass through the collector where the browser half of the
 * rule lives.
 *
 * ============================================================================
 * Failure isolation and shutdown
 * ============================================================================
 *
 * Per-site failure is caught INSIDE the site loop (the CP3 lesson: discovery is
 * `ORDER BY site_id LIMIT n`, so an uncaught throw on one site starves every
 * site sorting after it, permanently and silently). The failing site releases
 * its lease without advancing, so the next pass retries the identical horizon —
 * safe because the whole computation is a pure function of stored inputs.
 *
 * The stop flag is threaded INTO the tick rather than only guarding its start
 * (the CP2 lesson), so a shutdown cuts BETWEEN sites. Cutting there loses
 * nothing: each site's watermark is durable before the next site is claimed.
 *
 * ============================================================================
 * Secrets and logs
 * ============================================================================
 *
 * `ANONYMOUS_IDENTITY_SECRET` is held read-only (D6 amendment) for one purpose:
 * hashing a checkout hint's `client_reference_id` into the `identify()`
 * derivation so it joins `session_facts_versions.user_id` byte for byte. No
 * hash, no visitor id, no order id and no customer identifier is ever logged —
 * the log lines carry counts, the site id and the `matched_via` histogram.
 */

const MS_PER_DAY = 86_400_000

/** Sites per tick. Bounded so one enormous account cannot consume a tick others wait in. */
const DEFAULT_SITE_LIMIT = 25

/**
 * How stale a watermark may get before the site is re-run with no Postgres-side
 * trigger at all.
 *
 * This is the ONLY way a late conversion event or a late-finalized session is
 * ever noticed: both live in ClickHouse and a Postgres discovery query cannot
 * see them at any price. Fifteen minutes matches the reconcile loop's cadence
 * and sits comfortably inside the 24-hour lateness allowance, and the run it
 * triggers is cheap by construction — the planner writes nothing when no
 * fingerprint moved.
 */
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60_000

const DEFAULT_INTERVAL_MS = 60_000

/** The lease has to outlive one site's reads comfortably; the finalizer's shape. */
const DEFAULT_LEASE_TTL_MS = 5 * 60_000

export interface RevenueAttributionDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  /** Reads and writes `revenue_attributions`, plus the two input reads. */
  readonly store: RevenueAttributionsStore
  /** Reads the current `revenue_events` facts — the charges to attribute. */
  readonly facts: RevenueEventsStore
  /**
   * The `revenue_15m`/`revenue_1d` swap targets (ClickHouse 0018 and 0026).
   *
   * The rollup runs as a **step of this job** rather than as a loop of its own,
   * and `apps/worker/src/revenue/rollup.ts` gives the four reasons — the lease,
   * the shared fact read, the ordering guarantee and the discovery predicate all
   * already exist here and would otherwise be built twice.
   */
  readonly rollups: RevenueRollupsStore
  /**
   * `ANONYMOUS_IDENTITY_SECRET` + its key version, passed in rather than read
   * here so the loop cannot be constructed without a caller having decided the
   * key exists — and so a test drives the identical derivation with a test
   * secret.
   */
  readonly identityKey: IdentityKey
  /**
   * The lifecycle fence (ADR-0030, decision 7), injected exactly as the
   * finalizer's is.
   *
   * Discovery asks Postgres "which sites have revenue objects" — a question a
   * site being deleted still answers yes to, right up until `postgres_purge`.
   * Without the filter this job would keep writing attribution rows into a table
   * `clickhouse_purge` has already verified as empty.
   */
  readonly filterAttributable: (siteIds: readonly string[]) => Promise<string[]>
  /** Lease holder identity — the worker's consumer name. */
  readonly claimedBy: string
  /** `EVENT_MAX_LATENESS_HOURS` in ms. The horizon's second term. */
  readonly latenessMs: number
  readonly windowDays?: number
  readonly siteLimit?: number
  readonly refreshIntervalMs?: number
  readonly leaseTtlMs?: number
  readonly intervalMs?: number
  /** Cooperative cancellation, checked between sites. */
  readonly stopped?: () => boolean
  readonly now?: () => Date
}

export interface RevenueAttributionResult {
  readonly sites: number
  readonly attributed: number
  readonly rows: number
  readonly failed: number
  readonly skipped: number
  readonly matchedVia: Readonly<Record<RevenueMatchedVia, number>>
}

/** One tick. Extracted so tests drive it directly rather than through a timer. */
export async function attributeRevenueOnce(
  deps: RevenueAttributionDeps,
): Promise<RevenueAttributionResult> {
  const clock = deps.now ?? (() => new Date())
  const nowMs = clock().getTime()
  const siteLimit = deps.siteLimit ?? DEFAULT_SITE_LIMIT
  const refreshIntervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS

  const discovered = await listSitesForRevenueAttribution(deps.db, {
    staleBefore: new Date(nowMs - refreshIntervalMs),
    limit: siteLimit,
  })
  await publishLag(deps, nowMs)

  const totals: Record<RevenueMatchedVia, number> = {
    conversion_event: 0,
    client_reference: 0,
    customer_identity: 0,
    none: 0,
  }
  if (discovered.length === 0) {
    return { sites: 0, attributed: 0, rows: 0, failed: 0, skipped: 0, matchedVia: totals }
  }

  const siteIds = await deps.filterAttributable(discovered)

  let attributed = 0
  let rows = 0
  let failed = 0
  let skipped = 0

  for (const siteId of siteIds) {
    // Stop BETWEEN sites (the CP2 lesson). Nothing is lost: the previous site's
    // watermark is durable and this one has not been claimed.
    if (deps.stopped?.() === true) {
      skipped += 1
      continue
    }
    const outcome = await attributeSite(deps, { siteId, nowMs })
    rows += outcome.rows
    for (const via of Object.keys(totals) as RevenueMatchedVia[]) {
      totals[via] += outcome.matchedVia[via]
    }
    if (outcome.status === 'ok') attributed += 1
    if (outcome.status === 'failed') failed += 1
    if (outcome.status === 'skipped') skipped += 1
  }

  return { sites: siteIds.length, attributed, rows, failed, skipped, matchedVia: totals }
}

interface SiteOutcome {
  readonly status: 'ok' | 'failed' | 'skipped'
  readonly rows: number
  readonly matchedVia: Readonly<Record<RevenueMatchedVia, number>>
}

const NO_MATCHES: Readonly<Record<RevenueMatchedVia, number>> = {
  conversion_event: 0,
  client_reference: 0,
  customer_identity: 0,
  none: 0,
}

/**
 * One site, one run.
 *
 * Claim, fence-recheck, read the horizon's inputs, plan, insert, advance. The
 * order is the guarantee: attributions are durable before the watermark moves,
 * so a crash anywhere is recovered by a re-run that recomputes the same horizon
 * and finds nothing left to write.
 */
export async function attributeSite(
  deps: RevenueAttributionDeps,
  input: { siteId: string; nowMs: number },
): Promise<SiteOutcome> {
  const { siteId, nowMs } = input
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS

  const claim = await claimRevenueAttributionSite(deps.db, {
    siteId,
    claimedBy: deps.claimedBy,
    leaseTtlMs,
    now: new Date(nowMs),
  })
  if (!claim) {
    deps.metrics.increment(WORKER_METRICS.revenueAttributionSkipped, { reason: 'leased' })
    return { status: 'skipped', rows: 0, matchedVia: NO_MATCHES }
  }

  // The inner half of the lifecycle fence (ADR-0030, decision 7). The driver
  // already filtered discovery, but this run may have been queued before the
  // site was marked `deleting`. Releasing rather than holding: this run has
  // decided it has no work, and a held lease would make a deletion wait out the
  // whole TTL for nothing.
  const attributable = await deps.filterAttributable([siteId])
  if (attributable.length === 0) {
    await release(deps, siteId)
    deps.metrics.increment(WORKER_METRICS.revenueAttributionSkipped, { reason: 'lifecycle' })
    deps.logger.info('revenue_attribution_skipped_lifecycle', { site_id: siteId })
    return { status: 'skipped', rows: 0, matchedVia: NO_MATCHES }
  }

  const startedAt = Date.now()
  try {
    const windowDays = deps.windowDays ?? REVENUE_ATTRIBUTION_WINDOW_DAYS
    const horizon = await resolveHorizon(deps, {
      siteId,
      nowMs,
      windowDays,
      computedThrough: claim.computedThrough,
    })

    // --- Is the projection quiet? Asked BEFORE anything is read -----------
    //
    // Half of the cursor-advance precondition, and it only means anything from
    // here. If the projection is behind when this pass reads its facts, the
    // amounts it reads may still be in the site's PREVIOUS reporting currency —
    // and if the projection then finishes mid-pass, the advance's own
    // `NOT EXISTS` would look perfectly clean and move the cursor past a chunk
    // built from stale numbers. Nothing would ever come back to it: the heads'
    // `updated_at` is behind the watermark by then, `computed_through` has
    // advanced, and the cursor has moved on. Migration 0037 argues this at
    // length.
    const projectedBeforeRead = await isSiteFullyProjected(deps.db, siteId)

    // --- How far the watermark may move ------------------------------------
    //
    // The other half of the same race, on the watermark rather than the cursor.
    // A head the projection had not reached is missing from the facts this pass
    // reads, so the pass has not computed it — and advancing past its
    // `updated_at` would leave nothing to rediscover the site, because marking a
    // head projected does not move `updated_at`. A fresh connection lost its
    // whole backfill this way until the staleness clause came round. Stopping a
    // millisecond short keeps the head "changed since the watermark", so the next
    // tick picks the site up once the projection has caught up. Read with the
    // check above, before the facts, for the same reason.
    const unprojectedSince = projectedBeforeRead
      ? null
      : await readOldestUnprojectedRevenueObjectUpdate(deps.db, siteId)
    const watermarkMs =
      unprojectedSince === null ? nowMs : Math.min(nowMs, unprojectedSince.getTime() - 1)

    // --- The rollup range, and the escape hatch the horizon cannot provide --
    //
    // The ATTRIBUTION horizon is charge-only, and rightly so — only a charge
    // owns a journey. The ROLLUP floor cannot be, because of disputes: a dispute
    // is ONE object whose status changes, so `charge.dispute.closed` bumps only
    // the dispute head while its `occurred_at` stays the day it was opened,
    // sixty to ninety days earlier on Stripe's normal timeline. The charge-only
    // hatch cannot see that change at all, and the bucket would keep
    // `dispute_withdrawn_minor` forever while the transactions list showed the
    // dispute as won.
    const changedObjectFloor = await readOldestChangedRevenueObjectOccurrence(deps.db, {
      siteId,
      changedAfter: claim.computedThrough,
    })
    const rollup = revenueRollupRange({
      fromMs: horizon.fromMs,
      toMs: horizon.toMs,
      changedObjectFloorMs: changedObjectFloor?.getTime() ?? null,
    })
    const rollupRange = rollup.range

    // --- The facts, read once for both answers ----------------------------
    //
    // ONE ClickHouse read over the WIDER of the two ranges. The rollup needs
    // whole UTC days (a bucket rebuilt from the fraction of it the horizon
    // covered would be missing its own first minutes). The attribution horizon
    // is then taken by filtering in memory — safe because `occurred_at` is not a
    // column a version can change, so the filter and a narrower query return the
    // identical set.
    //
    // A pending re-roll CHUNK is deliberately not folded into this read: it is
    // disjoint from the horizon by construction, and unioning them would mean
    // reading every year in between — the unbounded read the chunk exists to
    // avoid.
    const allFacts = await deps.facts.readCurrentRows({
      siteId,
      fromMs: rollupRange.loMs,
      toMs: rollupRange.hiMs,
    })
    const facts = allFacts.filter(
      (fact) => fact.occurredAtMs >= horizon.fromMs && fact.occurredAtMs < horizon.toMs,
    )
    // Only charges are attributed: a refund or a dispute belongs to the journey
    // of the charge it points at, and D2d already puts its money in its own
    // bucket. A journey row of its own would double every converted-session
    // count.
    const chargeFacts = facts.filter((fact) => fact.objectKind === 'charge')

    const rollupDeps = { logger: deps.logger, metrics: deps.metrics, rollups: deps.rollups }

    /**
     * The rollup step (CP5): the ordinary range, then one chunk of any pending
     * re-roll walk, then the cursor bookkeeping.
     *
     * Hoisted into a closure because it must run on **every** path that reaches
     * a decided state, including the "no charges to attribute" one below. A site
     * whose only activity this month is a refund has nothing to attribute and a
     * bucket that must absolutely change; skipping the rollup with the
     * attribution would lose exactly the case D2d is about.
     */
    const runRollup = async (): Promise<number> => {
      let changed = (
        await rollUpRevenueSite(rollupDeps, {
          siteId,
          range: rollupRange,
          facts: allFacts.map(toRollupFact),
          generation: claim.rollupGenerationSeq,
          computedAtMs: nowMs,
        })
      ).changed

      // --- One chunk of a pending re-roll walk ----------------------------
      //
      // Bounded to a month of buckets per pass, with its own bounded read. The
      // first CP5 draft recomputed the whole history on every tick until the
      // marker cleared, which meant a three-year account repeatedly allocating
      // its entire fact table inside a process that also ingests events.
      const cursorMs = claim.rollupRecomputeFrom?.getTime() ?? null
      if (cursorMs !== null) {
        const chunk = revenueRecomputeChunk({ cursorMs, normalFloorMs: rollupRange.loMs })
        if (chunk === null) {
          // The cursor has caught up with the rolling horizon: the ordinary
          // rollup above already covered everything from here on.
          const cleared = await advanceRevenueRollupRecompute(deps.db, {
            siteId,
            to: null,
            onlyIfWasProjected: projectedBeforeRead,
          })
          if (!cleared) deps.metrics.increment(WORKER_METRICS.revenueRollupRecomputePending)
        } else {
          const chunkFacts = await deps.facts.readCurrentRows({
            siteId,
            fromMs: chunk.range.loMs,
            toMs: chunk.range.hiMs,
          })
          changed += (
            await rollUpRevenueSite(rollupDeps, {
              siteId,
              range: chunk.range,
              facts: chunkFacts.map(toRollupFact),
              // The same generation as the ordinary range. Safe because the two
              // ranges are disjoint, so no bucket is written twice in one pass.
              generation: claim.rollupGenerationSeq,
              computedAtMs: nowMs,
            })
          ).changed

          const moved = await advanceRevenueRollupRecompute(deps.db, {
            siteId,
            // Clearing rather than advancing when this chunk reached the
            // horizon, so the walk terminates instead of parking a cursor that
            // every later pass would re-evaluate for nothing.
            to: chunk.reachedHorizon ? null : new Date(chunk.range.hiMs),
            onlyIfWasProjected: projectedBeforeRead,
          })
          if (!moved) deps.metrics.increment(WORKER_METRICS.revenueRollupRecomputePending)
        }
      }

      // --- A floor too far back to have been read inline ------------------
      //
      // Applied AFTER the advance above, so a clear that just fired cannot wipe
      // it. `markRevenueRollupRecompute` takes the LEAST of the two, so a site
      // already walking a cursor keeps the older floor.
      if (rollup.deferredFloorMs !== null) {
        await markRevenueRollupRecompute(deps.db, {
          siteId,
          from: new Date(rollup.deferredFloorMs),
        })
      }

      return changed
    }

    if (chargeFacts.length === 0) {
      // Nothing to attribute, but the buckets may still have moved and the
      // watermark still advances — otherwise a site whose charges have all aged
      // out of the horizon would be rediscovered by the staleness clause on
      // every single tick forever.
      await runRollup()
      await advance(deps, siteId, watermarkMs)
      // Counted as a run, like every other path that reaches a decided state.
      // `revenueAttributionRuns` means "a site was processed and its watermark
      // advanced", so an empty horizon is a run — otherwise the counter would
      // quietly stop on a site that has simply gone quiet, and a rate alarm on
      // it could not tell that apart from the loop having died.
      deps.metrics.increment(WORKER_METRICS.revenueAttributionRuns)
      return { status: 'ok', rows: 0, matchedVia: NO_MATCHES }
    }

    // --- The site's own switch (ADR-0064 D4a, extended) --------------------
    //
    // `attributed_revenue` decides whether this site is attributed AT ALL, not
    // merely what its browsers send. D6 has three matching signals and only the
    // first one passes through the collector, so the ingest rule that strips
    // `order_id` cannot reach the other two: `client_reference_id` and
    // `metadata.oa_external_id` travel from the site's own server to Stripe and
    // reach us on the webhook. A site that had switched linking off would still
    // have watched journeys appear — the setting would have been describing the
    // browser rather than the product.
    //
    // ONE decision, here, rather than three signal-level suppressions: the
    // planner keeps knowing nothing about site settings, and there is no path
    // that quietly acquires a fourth signal without passing this line (the same
    // reason `mayCollect()` is a single gate in the tracker).
    //
    // Placed AFTER the rollup closure and BEFORE every attribution-only read.
    // The buckets are money, not journeys: totals, per-day and per-hour revenue
    // are outside this switch by decision (ADR-0064 D4) and must keep moving for
    // a site with linking off, so this path still rolls up and still advances the
    // watermark. What stops is the linking half — the hints, the conversion
    // signals, the touchpoints and the write.
    //
    // Forward-only: stored `revenue_attributions` rows are left exactly as they
    // are. Turning the switch off is not a deletion request, and rewriting
    // history on a settings change is the one thing this system never does
    // (ADR-0063 (f)).
    const settings = await readSiteIngestSettings(deps.db, siteId)
    if (settings?.settings.attributedRevenue !== true) {
      // Never silent. "Why is this site not attributed?" has to be answerable
      // from the metric rather than from reading this function.
      deps.metrics.increment(WORKER_METRICS.revenueAttributionSkipped, {
        reason: 'attribution_off',
      })
      deps.logger.info('revenue_attribution_skipped_flag', {
        site_id: siteId,
        charges: chargeFacts.length,
      })
      await runRollup()
      await advance(deps, siteId, watermarkMs)
      deps.metrics.increment(WORKER_METRICS.revenueAttributionRuns)
      return { status: 'ok', rows: 0, matchedVia: NO_MATCHES }
    }

    // --- The checkout hints ----------------------------------------------
    //
    // Read from Postgres rather than taken from the fact, because a hint can
    // land AFTER the head was projected: `checkout.session.completed` is a
    // separate delivery and it does not bump the object head's version (that is
    // the whole reason the hints table exists). So the fact may carry no
    // checkout session at all while the hint does, and reading the hint here is
    // what makes such a charge matchable before the head next moves.
    //
    // Looked up PER PROVIDER, for the reason the projection loop gives:
    // `revenue_match_hints` is keyed by it, and two providers could in principle
    // mint the same PaymentIntent-shaped id, so a cross-provider join would
    // attribute one provider's checkout to another's charge. In practice a site
    // has one connected credential and this loop runs once.
    const hintsByProvider = new Map<string, Map<string, RevenueMatchHintRow>>()
    for (const provider of new Set(chargeFacts.map((fact) => fact.provider))) {
      hintsByProvider.set(
        provider,
        await readRevenueMatchHintsByOrder(deps.db, {
          siteId,
          provider,
          orderIds: chargeFacts
            .filter((fact) => fact.provider === provider)
            .map((fact) => fact.orderId),
        }),
      )
    }

    const charges = chargeFacts.map((fact) =>
      toAttributableCharge({
        fact,
        hint: hintsByProvider.get(fact.provider)?.get(fact.orderId) ?? null,
        siteId,
        identityKey: deps.identityKey,
      }),
    )

    // --- The stored answers ----------------------------------------------
    const stored = await deps.store.readStoredAttributions({
      siteId,
      fromMs: horizon.fromMs,
      toMs: horizon.toMs,
    })

    // --- Signal 1: conversion events -------------------------------------
    //
    // Bounded by the order-id set: without it this is "every conversion event
    // this site fired in a month", which on a site that fires conversions for
    // newsletter signups is a great many rows that can match nothing.
    //
    // The lower bound reaches one lateness allowance below the charge horizon,
    // because a conversion event can be accepted up to that late and a charge
    // sitting exactly on the horizon's floor may have fired its conversion just
    // before it.
    const orderIds = charges.flatMap((charge) => [
      charge.orderId,
      charge.checkoutSessionId,
      charge.objectId,
    ])
    const conversions = await deps.store.readConversionSignals({
      siteId,
      fromMs: Math.max(0, horizon.fromMs - deps.latenessMs),
      toMs: horizon.toMs,
      orderIds,
    })

    // --- The touchpoints --------------------------------------------------
    //
    // Read only for the visitor keys the signals produced, and only over the
    // span **those charges** can reach back into. Both bounds are inclusive in
    // the store, matching the closed window D2a defines.
    //
    // The span is computed over MATCHABLE charges only, and that is a real cost
    // difference rather than tidiness. Anchoring it on every charge in the
    // horizon would make the floor `oldest horizon charge - 30 d`, i.e. up to 61
    // days of one site's sessions (120 on a first pass from the epoch) grouped
    // and scanned on every refresh — 96 times a day, forever, for a site whose
    // only matchable charge is from this morning. It cannot change a result: a
    // charge with no visitor key is `none` whatever the session read returned,
    // and a charge WITH one has its own window fully covered here.
    const signalledOrderIds = new Set(conversions.map((signal) => signal.orderId))
    const userIds: string[] = []
    const anonymousIds: string[] = []
    for (const signal of conversions) {
      if (signal.userId !== '') userIds.push(signal.userId)
      if (signal.anonymousId !== '') anonymousIds.push(signal.anonymousId)
    }

    let oldestMatchableMs = Number.POSITIVE_INFINITY
    let newestMatchableMs = 0
    for (const charge of charges) {
      if (charge.clientReferenceUserHash !== '') userIds.push(charge.clientReferenceUserHash)
      if (charge.customerIdentityUserHash !== '') userIds.push(charge.customerIdentityUserHash)

      const matchable =
        charge.clientReferenceUserHash !== '' ||
        charge.customerIdentityUserHash !== '' ||
        signalledOrderIds.has(charge.orderId) ||
        signalledOrderIds.has(charge.checkoutSessionId) ||
        signalledOrderIds.has(charge.objectId)
      if (!matchable) continue

      if (charge.occurredAtMs < oldestMatchableMs) oldestMatchableMs = charge.occurredAtMs
      if (charge.occurredAtMs > newestMatchableMs) newestMatchableMs = charge.occurredAtMs
    }

    // `oldestMatchableMs` finite is implied by a non-empty key set (a key comes
    // either from a charge's own hash or from a conversion event whose order id
    // was one of the charges'), but it is checked rather than assumed: an
    // infinite floor would send `fromMs > toMs` to ClickHouse, which returns
    // nothing and looks exactly like "this visitor has no sessions".
    const sessions =
      (userIds.length === 0 && anonymousIds.length === 0) || !Number.isFinite(oldestMatchableMs)
        ? []
        : await deps.store.readSessionTouchpoints({
            siteId,
            fromMs: Math.max(0, oldestMatchableMs - windowDays * MS_PER_DAY),
            toMs: newestMatchableMs,
            userIds,
            anonymousIds,
          })

    // --- The pure planner -------------------------------------------------
    const plan = planRevenueAttributions({
      charges,
      conversions: conversions.map((signal): ConversionSignal => ({
        orderId: signal.orderId,
        eventId: signal.eventId,
        occurredAtMs: signal.occurredAtMs,
        userId: signal.userId,
        anonymousId: signal.anonymousId,
      })),
      sessions: sessions.map((session): SessionTouchpoint => ({
        sessionId: session.sessionId,
        sessionStartMs: session.sessionStartMs,
        userId: session.userId,
        anonymousId: session.anonymousId,
        referrerDomain: session.referrerDomain,
        utmSource: session.utmSource,
        utmMedium: session.utmMedium,
        utmCampaign: session.utmCampaign,
        utmContent: session.utmContent,
        utmTerm: session.utmTerm,
        entryPagePath: session.entryPagePath,
      })),
      stored: stored.map(toStoredAttribution),
      windowDays,
    })

    // --- Write, then advance ---------------------------------------------
    if (plan.attributions.length > 0) {
      const rows = plan.attributions.map((attribution) =>
        toAttributionRow({ siteId, attribution, computedAtMs: nowMs }),
      )
      await deps.store.insertRows(rows)
      deps.metrics.increment(WORKER_METRICS.revenueAttributionRows, {}, rows.length)
    }

    for (const [via, count] of Object.entries(plan.matchedVia)) {
      if (count > 0) {
        deps.metrics.increment(
          WORKER_METRICS.revenueAttributionMatched,
          { matched_via: via },
          count,
        )
      }
    }

    // --- Then the buckets, then the watermark -----------------------------
    //
    // The finalizer's order, one milestone later: the fact-shaped writes are
    // durable before the rollups that summarise them, and the watermark moves
    // only after both — so a crash anywhere is recovered by a re-run that
    // recomputes the same horizon and finds nothing left to do.
    await runRollup()

    await advance(deps, siteId, watermarkMs)
    deps.metrics.increment(WORKER_METRICS.revenueAttributionRuns)

    if (plan.changed > 0) {
      deps.logger.info('revenue_attributed', {
        site_id: siteId,
        charges: charges.length,
        changed: plan.changed,
        version: plan.version,
        matched_via: plan.matchedVia,
        horizon_from_ms: horizon.fromMs,
        duration_ms: Date.now() - startedAt,
      })
    }

    return { status: 'ok', rows: plan.changed, matchedVia: plan.matchedVia }
  } catch (err) {
    // Released without advancing, so the next pass retries the identical
    // horizon — safe because the whole computation is a pure function of stored
    // inputs. Caught here rather than thrown so the sweep continues: discovery
    // is `ORDER BY site_id LIMIT n`, and an escaping throw would starve every
    // site sorting after this one.
    deps.metrics.increment(WORKER_METRICS.revenueAttributionFailed, { reason: 'site' })
    deps.logger.error('revenue_attribution_failed', {
      // The message, truncated — never the error object. See `safeError`.
      err: safeError(err),
      site_id: siteId,
      retryable: true,
    })
    await release(deps, siteId)
    return { status: 'failed', rows: 0, matchedVia: NO_MATCHES }
  }
}

// --- The horizon -------------------------------------------------------------

interface Horizon {
  readonly fromMs: number
  readonly toMs: number
}

/** The three-term rule from the module header, in one place. */
async function resolveHorizon(
  deps: RevenueAttributionDeps,
  input: { siteId: string; nowMs: number; windowDays: number; computedThrough: Date },
): Promise<Horizon> {
  const rollingFloorMs = input.nowMs - (input.windowDays * MS_PER_DAY + deps.latenessMs)
  const computedThroughMs = input.computedThrough.getTime()

  // The backfill escape hatch. Asked once per due site, over the index migration
  // 0034 created — on an ordinary tick it matches the handful of heads that
  // moved since the last run.
  const oldestChanged = await readOldestChangedRevenueChargeOccurrence(deps.db, {
    siteId: input.siteId,
    changedAfter: input.computedThrough,
  })

  const fromMs = Math.max(
    0,
    Math.min(
      rollingFloorMs,
      computedThroughMs,
      oldestChanged === null ? Number.POSITIVE_INFINITY : oldestChanged.getTime(),
    ),
  )
  // Half-open upper bound, so a charge stamped exactly `now` is inside it.
  return { fromMs, toMs: input.nowMs + 1 }
}

// --- Mapping -----------------------------------------------------------------

/**
 * A current fact plus its hint becomes the planner's charge input.
 *
 * **The two identity hashes are the interesting part.**
 *
 * `clientReferenceUserHash` (D6 signal 2) is the fact's `external_user_hash`
 * whenever the fact has one, because CP3's `resolveRevenueExternalUserId`
 * resolves that column from a client reference and from nothing else — so the
 * value on the fact IS the client-reference derivation. When the fact has none
 * but a hint does, the hash is computed HERE: that is the case where
 * `checkout.session.completed` arrived after the head was projected, and it is
 * exactly why the worker holds `ANONYMOUS_IDENTITY_SECRET` at all. The
 * derivation is `externalUserIdHash`, byte for byte the one the collector
 * applies to `identify()`, or the join against `user_id` would match nothing
 * while looking entirely reasonable.
 *
 * `customerIdentityUserHash` (D6 signal 3) is **always empty in CP4**, and that
 * is recorded rather than papered over. D5 words the signal as
 * `metadata.oa_external_id`, else the customer email. Neither is reachable from
 * anything at rest: `oa_external_id` lives on the Stripe *Customer*, which the
 * sync walk never lists, and an email is never stored in any form (D-102 forbids
 * the raw value and the api, which receives the payload, does not hold the
 * secret that would produce a hashed one). The field is threaded through the
 * planner anyway so the checkpoint that fetches a Customer in flight supplies it
 * without a caller, a signature or a test changing shape — the same discipline
 * `resolveRevenueExternalUserId` used one checkpoint earlier.
 */
function toAttributableCharge(input: {
  fact: {
    objectId: string
    provider: string
    occurredAtMs: number
    status: string
    orderId: string
    checkoutSessionId: string
    externalUserHash: string
  }
  hint: RevenueMatchHintRow | null
  siteId: string
  identityKey: IdentityKey
}): AttributableCharge {
  const { fact, hint } = input

  const clientReferenceUserHash =
    fact.externalUserHash !== ''
      ? fact.externalUserHash
      : hint !== null && hint.clientReferenceId !== ''
        ? externalUserIdHash({
            siteId: input.siteId,
            externalUserId: hint.clientReferenceId,
            key: input.identityKey,
          }).userId
        : ''

  return {
    objectId: fact.objectId,
    provider: fact.provider,
    occurredAtMs: fact.occurredAtMs,
    status: fact.status,
    orderId: fact.orderId,
    checkoutSessionId:
      fact.checkoutSessionId !== '' ? fact.checkoutSessionId : (hint?.checkoutSessionId ?? ''),
    clientReferenceUserHash,
    customerIdentityUserHash: '',
  }
}

function toStoredAttribution(row: {
  objectId: string
  provider: string
  version: number
  occurredAtMs: number
  modelVersion: number
  windowDays: number
  matchedVia: string
  confidence: string
  identityScope: string
  visitorId: string
  userId: string
  ftSessionId: string
  ftSessionStartMs: number
  ftReferrerDomain: string
  ftUtmSource: string
  ftUtmMedium: string
  ftUtmCampaign: string
  ftUtmContent: string
  ftUtmTerm: string
  ftEntryPage: string
  ltSessionId: string
  ltSessionStartMs: number
  ltReferrerDomain: string
  ltUtmSource: string
  ltUtmMedium: string
  ltUtmCampaign: string
  ltUtmContent: string
  ltUtmTerm: string
  ltEntryPage: string
  touchpointCount: number
  journeyTruncated: number
  journey: string
}): StoredRevenueAttribution {
  return {
    objectId: row.objectId,
    provider: row.provider,
    version: row.version,
    occurredAtMs: row.occurredAtMs,
    modelVersion: row.modelVersion,
    windowDays: row.windowDays,
    matchedVia: row.matchedVia as StoredRevenueAttribution['matchedVia'],
    confidence: row.confidence as StoredRevenueAttribution['confidence'],
    identityScope: row.identityScope as StoredRevenueAttribution['identityScope'],
    visitorId: row.visitorId,
    userId: row.userId,
    firstTouch: {
      sessionId: row.ftSessionId,
      sessionStartMs: row.ftSessionStartMs,
      referrerDomain: row.ftReferrerDomain,
      utmSource: row.ftUtmSource,
      utmMedium: row.ftUtmMedium,
      utmCampaign: row.ftUtmCampaign,
      utmContent: row.ftUtmContent,
      utmTerm: row.ftUtmTerm,
      entryPage: row.ftEntryPage,
    },
    lastTouch: {
      sessionId: row.ltSessionId,
      sessionStartMs: row.ltSessionStartMs,
      referrerDomain: row.ltReferrerDomain,
      utmSource: row.ltUtmSource,
      utmMedium: row.ltUtmMedium,
      utmCampaign: row.ltUtmCampaign,
      utmContent: row.ltUtmContent,
      utmTerm: row.ltUtmTerm,
      entryPage: row.ltEntryPage,
    },
    touchpointCount: row.touchpointCount,
    journeyTruncated: row.journeyTruncated === 1,
    journey: row.journey,
  }
}

/** ClickHouse `DateTime64(3, 'UTC')` literal from epoch ms. */
function chInstant(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

export function toAttributionRow(input: {
  siteId: string
  attribution: ComputedRevenueAttribution
  computedAtMs: number
}): RevenueAttributionRow {
  const a = input.attribution
  return {
    site_id: input.siteId,
    provider: a.provider,
    object_id: a.objectId,
    version: a.version,
    occurred_at: chInstant(a.occurredAtMs),
    model_version: a.modelVersion,
    window_days: a.windowDays,
    matched_via: a.matchedVia,
    confidence: a.confidence,
    identity_scope: a.identityScope,
    visitor_id: a.visitorId,
    user_id: a.userId,
    ft_session_id: a.firstTouch.sessionId,
    ft_session_start: chInstant(a.firstTouch.sessionStartMs),
    ft_referrer_domain: a.firstTouch.referrerDomain,
    ft_utm_source: a.firstTouch.utmSource,
    ft_utm_medium: a.firstTouch.utmMedium,
    ft_utm_campaign: a.firstTouch.utmCampaign,
    ft_utm_content: a.firstTouch.utmContent,
    ft_utm_term: a.firstTouch.utmTerm,
    ft_entry_page: a.firstTouch.entryPage,
    lt_session_id: a.lastTouch.sessionId,
    lt_session_start: chInstant(a.lastTouch.sessionStartMs),
    lt_referrer_domain: a.lastTouch.referrerDomain,
    lt_utm_source: a.lastTouch.utmSource,
    lt_utm_medium: a.lastTouch.utmMedium,
    lt_utm_campaign: a.lastTouch.utmCampaign,
    lt_utm_content: a.lastTouch.utmContent,
    lt_utm_term: a.lastTouch.utmTerm,
    lt_entry_page: a.lastTouch.entryPage,
    touchpoint_count: a.touchpointCount,
    journey_truncated: a.journeyTruncated ? 1 : 0,
    journey: a.journey,
    computed_at: chInstant(input.computedAtMs),
  }
}

// --- Control state -----------------------------------------------------------

async function advance(
  deps: RevenueAttributionDeps,
  siteId: string,
  computedThroughMs: number,
): Promise<void> {
  await advanceRevenueAttributionWatermark(deps.db, {
    siteId,
    claimedBy: deps.claimedBy,
    computedThrough: new Date(computedThroughMs),
    now: new Date(computedThroughMs),
  })
}

/**
 * A safe, bounded error string for a log line.
 *
 * The rest of the worker logs `{ err }` and lets the observability layer's
 * redaction handle it. This loop does not, and the reason is specific to what it
 * talks to: the ClickHouse client raises the **server's message, which echoes
 * the failing query**, and two of this job's three reads carry visitor
 * pseudonyms — the `user_id`/`anonymous_id` arrays of the touchpoint read and
 * the order ids of the conversion read. They are bound as query parameters
 * rather than interpolated, so the query TEXT holds placeholders; but the server
 * is free to include the substituted values in an exception, and a redactor that
 * has never been shown a ClickHouse error is not a guarantee that it will not.
 *
 * Logging the message rather than the error object drops the stack (which is
 * where a client library most readily attaches a request dump) and the 300-char
 * cap keeps a long echoed query from carrying an array of hashes into a log
 * aggregator. What survives is the part an operator needs: the ClickHouse error
 * code and its first sentence, or the Postgres constraint name.
 */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

async function release(deps: RevenueAttributionDeps, siteId: string): Promise<void> {
  await releaseRevenueAttributionSite(deps.db, {
    siteId,
    claimedBy: deps.claimedBy,
  }).catch((err: unknown) => {
    deps.logger.error('revenue_attribution_release_failed', {
      err: safeError(err),
      site_id: siteId,
      retryable: false,
    })
  })
}

/**
 * The lag gauge, zero-filled.
 *
 * Age of the OLDEST watermark, not the newest, and zero when no site has one:
 * a series that exists only while the job is behind cannot be told apart from a
 * job that stopped running, and an alert on it would stay dark exactly when it
 * mattered.
 */
async function publishLag(deps: RevenueAttributionDeps, nowMs: number): Promise<void> {
  const oldest = await readOldestRevenueAttributionWatermark(deps.db)
  const lagMs = oldest === null ? 0 : Math.max(0, nowMs - oldest.getTime())
  deps.metrics.gauge(WORKER_METRICS.revenueAttributionLagMs, lagMs, {})
}

// --- The loop ----------------------------------------------------------------

export interface RevenueAttributionLoop {
  /** Runs one pass immediately. Exposed so tests skip the timer. */
  runOnce(): Promise<RevenueAttributionResult>
  stop(): Promise<void>
}

/**
 * The interval loop, in the projection loop's shape: a re-entrancy guard, an
 * unref'd timer so the loop alone never keeps the process alive, and a `stop`
 * that drains an in-flight tick.
 */
export function startRevenueAttribution(deps: RevenueAttributionDeps): RevenueAttributionLoop {
  let running = false
  let stopped = false

  const runOnce = async (): Promise<RevenueAttributionResult> =>
    await attributeRevenueOnce({ ...deps, stopped: () => stopped || deps.stopped?.() === true })

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await runOnce()
      if (result.rows > 0 || result.failed > 0) {
        deps.logger.info('revenue_attribution_swept', { ...result })
      }
    } catch (err) {
      // A throw here is a bug or a Postgres outage. Logged and swallowed: this
      // loop shares a process with batch ingest, the finalizer and email
      // delivery, and an unhandled rejection would take all of them down over an
      // attribution pass.
      deps.metrics.increment(WORKER_METRICS.revenueAttributionFailed, { reason: 'tick' })
      deps.logger.error('revenue_attribution_tick_failed', {
        err: safeError(err),
        retryable: true,
      })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref()

  return {
    runOnce,
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
