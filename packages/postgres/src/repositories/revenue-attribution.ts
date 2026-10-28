import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database, Executor } from '../client.ts'
import { revenueAttributionState, revenueMatchHints, revenueObjects } from '../schema/revenue.ts'

/**
 * The attribution job's control-state repository (migration 0036; ADR-0033 D6).
 * Milestone 12 Checkpoint 4.
 *
 * Four operations on the control row — claim, advance, release, get — plus the
 * two discovery reads, and nothing else. It is `session-finalizer.ts` again,
 * deliberately: the same conditional-upsert lease, the same `GREATEST` guard on
 * the watermark, the same "only the lease holder may advance" predicate. The
 * attribution job is the finalizer idiom applied to a different fact, so a
 * second lease shape here would be a second set of lease bugs to find.
 *
 * Nothing in this table ever decides a ClickHouse version. The job mints
 * `max(stored version in the horizon) + 1` from ClickHouse itself at write time,
 * so the worst a stale read here can do is redo idempotent work.
 */

export interface RevenueAttributionClaim {
  /** The instant whose inputs this site was last computed against. Epoch on a fresh site. */
  readonly computedThrough: Date
  readonly runSeq: number
  /**
   * The full-site rollup re-roll floor, or null (migration 0037; CP5).
   *
   * Non-null means a reporting-currency change has invalidated every stored
   * bucket, including the ones older than the rolling horizon. It widens the
   * ROLLUP range only — an attribution carries no money, so re-reading a site's
   * whole session history to recompute journeys that cannot have changed would
   * be cost with no answer attached.
   */
  readonly rollupRecomputeFrom: Date | null
  /**
   * This run's ClickHouse swap generation (migration 0037).
   *
   * Minted by the claim itself rather than as `max(stored) + 1`, because nothing
   * renews the five-minute lease: a run that outlives its own lease and the
   * worker that took it would otherwise read the same stored maximum and write
   * the same generation, which is the one thing ReplacingMergeTree cannot
   * resolve. Only one worker can win a claim, so every run holds a distinct
   * number and the newer run's is always higher.
   */
  readonly rollupGenerationSeq: number
}

/**
 * Claim a site for attribution, taking or creating its control row.
 *
 * One conditional upsert, the batch-manifest idiom the finalizer already uses:
 * the row is inserted if absent and updated only when the lease is free, held by
 * this same worker, or expired. Two workers racing on one site cannot both come
 * out holding it — the loser's `ON CONFLICT` predicate matches nothing and it
 * gets no row back.
 */
export async function claimRevenueAttributionSite(
  db: Database,
  input: { siteId: string; claimedBy: string; leaseTtlMs: number; now?: Date },
): Promise<RevenueAttributionClaim | null> {
  const now = input.now ?? new Date()
  const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs)

  // Non-null because the operands are concrete conditions, so `or` always yields
  // a clause.
  const takeableLease = or(
    isNull(revenueAttributionState.claimedBy),
    eq(revenueAttributionState.claimedBy, input.claimedBy),
    lt(revenueAttributionState.leaseExpiresAt, now),
  )!

  const rows = await db
    .insert(revenueAttributionState)
    .values({
      siteId: input.siteId,
      claimedBy: input.claimedBy,
      leaseExpiresAt,
      updatedAt: now,
      // The INSERT branch is a claim too, so it holds generation 1 rather than
      // the column's default of 0. Without this the first two claims on a site
      // would BOTH read 1 — the insert leaving 0 behind and the next update
      // bumping it to 1 — which is exactly the tie the counter exists to make
      // impossible. The column default stays 0 so the migration is additive
      // with no backfill.
      rollupGenerationSeq: 1,
    })
    .onConflictDoUpdate({
      target: revenueAttributionState.siteId,
      set: {
        claimedBy: input.claimedBy,
        leaseExpiresAt,
        updatedAt: now,
        // Bumped by the claim, so the number belongs to the run that won it and
        // to no other. A loser's `ON CONFLICT` predicate matches nothing and it
        // gets neither the row nor a generation.
        rollupGenerationSeq: sql`${revenueAttributionState.rollupGenerationSeq} + 1`,
      },
      setWhere: takeableLease,
    })
    .returning({
      computedThrough: revenueAttributionState.computedThrough,
      runSeq: revenueAttributionState.runSeq,
      rollupRecomputeFrom: revenueAttributionState.rollupRecomputeFrom,
      rollupGenerationSeq: revenueAttributionState.rollupGenerationSeq,
    })

  const row = rows[0]
  if (!row) return null
  return {
    computedThrough: row.computedThrough,
    runSeq: Number(row.runSeq),
    rollupRecomputeFrom: row.rollupRecomputeFrom,
    rollupGenerationSeq: Number(row.rollupGenerationSeq),
  }
}

/**
 * Whether every one of a site's revenue heads has been projected.
 *
 * Read BEFORE the rollup's fact read, and again inside the cursor advance's own
 * `WHERE`. Both are needed and migration 0037 argues why at length: the check at
 * advance time alone would let a pass read facts while the projection was behind
 * (amounts still in the previous reporting currency), have the projection finish
 * during the pass, and then advance the cursor past a chunk built from stale
 * numbers — with nothing left that could ever bring the site back to it.
 */
export async function isSiteFullyProjected(db: Executor, siteId: string): Promise<boolean> {
  const rows = await db
    .select({ id: revenueObjects.id })
    .from(revenueObjects)
    .where(
      and(
        eq(revenueObjects.siteId, siteId),
        sql`${revenueObjects.projectedVersion} < ${revenueObjects.version}`,
      ),
    )
    .limit(1)
  return rows.length === 0
}

/**
 * The oldest `updated_at` among a site's heads the projection has not reached,
 * or null when it has reached them all.
 *
 * The attribution watermark's ceiling. Discovery finds a site again only through
 * a head changed *after* `computed_through`, and marking a head projected moves
 * `projected_version`, not `updated_at` — so a pass that read its facts before
 * the projection caught up, and then advanced past those heads, left nothing
 * that could bring the site back until the staleness clause fired. On a fresh
 * connection that is the backfill itself: revenue read as zero for up to a whole
 * refresh interval. Read at the same moment as `isSiteFullyProjected`, before
 * the facts are.
 */
export async function readOldestUnprojectedRevenueObjectUpdate(
  db: Executor,
  siteId: string,
): Promise<Date | null> {
  const rows = await db
    .select({ oldest: sql<string | null>`min(${revenueObjects.updatedAt})` })
    .from(revenueObjects)
    .where(
      and(
        eq(revenueObjects.siteId, siteId),
        sql`${revenueObjects.projectedVersion} < ${revenueObjects.version}`,
      ),
    )

  const oldest = rows[0]?.oldest
  if (oldest === null || oldest === undefined) return null
  const parsed = new Date(oldest)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Mark a site for a full-site rollup recompute (migration 0037; ADR-0033
 * D2c/D7). Milestone 12 Checkpoint 5.
 *
 * Called by the reporting-currency `PATCH` **inside the same transaction** as
 * `resetRevenueProjection`, because the two halves of a currency change are one
 * decision: the facts must be restated at a higher version AND every bucket that
 * summed the old ones must be rebuilt. Committing one without the other leaves a
 * site whose facts and totals disagree, in a way no later pass would notice.
 *
 * An upsert, because a site can change its reporting currency before the
 * attribution job has ever run for it — there is then no control row, and the
 * insert creates one whose `computed_through` is still the epoch, which is
 * exactly right (the first pass covers everything anyway).
 *
 * The floor is taken from the caller rather than assumed, so the same mechanism
 * can later express a bounded re-roll. Today the only writer passes the epoch.
 *
 * `GREATEST` is deliberately NOT used: two currency changes in a row must leave
 * the OLDER floor standing, and `LEAST` over a null-able column is spelled out
 * so a first mark and a subsequent one behave the same.
 */
export async function markRevenueRollupRecompute(
  db: Executor,
  input: { readonly siteId: string; readonly from: Date; readonly now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .insert(revenueAttributionState)
    .values({ siteId: input.siteId, rollupRecomputeFrom: input.from, updatedAt: now })
    .onConflictDoUpdate({
      target: revenueAttributionState.siteId,
      set: {
        rollupRecomputeFrom: sql`LEAST(COALESCE(${revenueAttributionState.rollupRecomputeFrom}, ${input.from}), ${input.from})`,
        updatedAt: now,
      },
    })
}

/**
 * Advance the watermark and release the lease at the end of a successful run.
 *
 * `GREATEST` rather than a plain assignment, for the finalizer's reason: the
 * caller has already clamped the value to be monotonic, and this is the
 * belt-and-braces refusal to move it backwards even if a caller regressed.
 * Moving it backwards would not lose data — the horizon is rolling and the
 * writes are fingerprint-compared — but it would make the watermark
 * uninterpretable as a freshness signal, which is the other thing CP5 reads it
 * for.
 *
 * Only the lease holder may advance: a run whose lease was stolen after it
 * started must not clobber the newer holder's state.
 */
export async function advanceRevenueAttributionWatermark(
  db: Database,
  input: { siteId: string; claimedBy: string; computedThrough: Date; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .update(revenueAttributionState)
    .set({
      computedThrough: sql`GREATEST(${revenueAttributionState.computedThrough}, ${input.computedThrough})`,
      runSeq: sql`${revenueAttributionState.runSeq} + 1`,
      claimedBy: null,
      leaseExpiresAt: null,
      lastRunAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(revenueAttributionState.siteId, input.siteId),
        eq(revenueAttributionState.claimedBy, input.claimedBy),
      ),
    )
}

/** Release a claimed site without advancing, for a run that failed. */
export async function releaseRevenueAttributionSite(
  db: Database,
  input: { siteId: string; claimedBy: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .update(revenueAttributionState)
    .set({ claimedBy: null, leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(revenueAttributionState.siteId, input.siteId),
        eq(revenueAttributionState.claimedBy, input.claimedBy),
      ),
    )
}

/**
 * Move the re-roll cursor forward, or clear it when the walk is finished.
 *
 * `to` is the start of the next chunk, or **null** to clear — which the caller
 * passes once a chunk has reached the floor of the rolling horizon, from where
 * the ordinary pass covers everything.
 *
 * This is the whole safety property of the design, and it is one statement so
 * that "the rollup ran over re-projected facts" and "the cursor moved" cannot
 * come apart under a crash or a concurrent projection tick. The `NOT EXISTS`
 * below is the advance-time half of the precondition; the caller supplies the
 * other half by having captured `isSiteFullyProjected` **before** its fact read
 * and passing `onlyIfWasProjected`. A pass that fails either half leaves the
 * cursor exactly where it was, and the discovery clause brings the site back.
 *
 * `onlyIfWasProjected` is a parameter rather than a caller-side `if` so the two
 * halves of one rule are visible in one place, and so the function can never be
 * called in a way that silently drops the earlier check.
 *
 * Returns whether the cursor moved, so the caller can publish the
 * "recompute still pending" gauge rather than guessing.
 */
export async function advanceRevenueRollupRecompute(
  db: Executor,
  input: {
    readonly siteId: string
    readonly to: Date | null
    readonly onlyIfWasProjected: boolean
    readonly now?: Date
  },
): Promise<boolean> {
  if (!input.onlyIfWasProjected) return false
  const now = input.now ?? new Date()
  const rows = await db
    .update(revenueAttributionState)
    .set({ rollupRecomputeFrom: input.to, updatedAt: now })
    .where(
      and(
        eq(revenueAttributionState.siteId, input.siteId),
        sql`${revenueAttributionState.rollupRecomputeFrom} IS NOT NULL`,
        // Monotonic: a cursor only ever moves forward. Belt and braces against a
        // caller that computed a chunk from a stale read.
        input.to === null
          ? sql`true`
          : sql`${revenueAttributionState.rollupRecomputeFrom} < ${input.to}`,
        sql`NOT EXISTS (
              SELECT 1 FROM ${revenueObjects}
               WHERE ${revenueObjects.siteId} = ${input.siteId}
                 AND ${revenueObjects.projectedVersion} < ${revenueObjects.version}
            )`,
      ),
    )
    .returning({ siteId: revenueAttributionState.siteId })
  return rows.length > 0
}

export interface RevenueAttributionStateRow {
  readonly siteId: string
  readonly computedThrough: Date
  readonly runSeq: number
  readonly lastRunAt: Date | null
  readonly claimedBy: string | null
  /** The pending full-site rollup re-roll cursor, or null (migration 0037). */
  readonly rollupRecomputeFrom: Date | null
  readonly rollupGenerationSeq: number
}

/** Read a site's control row — CP5's attribution freshness metadata, and tests. */
export async function getRevenueAttributionState(
  db: Executor,
  siteId: string,
): Promise<RevenueAttributionStateRow | null> {
  const [row] = await db
    .select()
    .from(revenueAttributionState)
    .where(eq(revenueAttributionState.siteId, siteId))
  if (!row) return null
  return {
    siteId: row.siteId,
    computedThrough: row.computedThrough,
    runSeq: Number(row.runSeq),
    lastRunAt: row.lastRunAt,
    claimedBy: row.claimedBy,
    rollupRecomputeFrom: row.rollupRecomputeFrom,
    rollupGenerationSeq: Number(row.rollupGenerationSeq),
  }
}

/**
 * The sites an attribution pass should consider.
 *
 * Three triggers, and the third one is not optional — it is the only way two of
 * the three input kinds can be discovered at all:
 *
 *   1. **An object head of ANY KIND changed after the watermark.** A new
 *      purchase, a refund, a dispute opening or closing, a reconcile
 *      re-observation. This is the immediate path, and it is what makes a fresh
 *      purchase attributable — and a fresh refund *subtractable* — within one
 *      tick.
 *
 *      It was charge-only until M12 CP7, and the live proof found what that
 *      cost. CP4 wrote this predicate when the pass did exactly one job,
 *      attribution, and only a charge owns a journey — so charge-only was
 *      correct then. CP5 gave the same pass a **second** job, the rollup swap,
 *      whose inputs are refunds and disputes as much as charges, and did not
 *      widen the predicate to match. In production a refund at 00:21 left
 *      `revenue_1h` at its old generation with `refund_minor` at 0 until an
 *      unrelated charge at 00:32 dragged the site back into discovery. Net was
 *      overstated for eleven minutes, and on a site with no further charge
 *      activity it would have stayed overstated until the staleness clause below
 *      fired — up to a whole refresh interval.
 *
 *      Nothing downstream needed changing: CP5's B3 had already widened the
 *      rollup floor to `readOldestChangedRevenueObjectOccurrence`, and the
 *      affected-bucket set has always been kind-blind, so a pass that RUNS
 *      rebuilds the bucket correctly. The hole was that the pass did not run.
 *   2. **A checkout hint changed after the watermark.** `checkout.session.
 *      completed` can arrive after the charge was already attributed `none`;
 *      the hint carries D6's second matching signal and nothing on the charge
 *      side moves when it lands.
 *   3. **The watermark is older than the refresh interval.** Conversion events
 *      live in `events_raw` and session facts in `session_facts_versions` —
 *      both ClickHouse, neither visible to a Postgres discovery query at any
 *      price. A conversion event may be 24 h late (D-016) and the session that
 *      is its touchpoint is not finalized until inactivity plus that lateness
 *      has passed, so the *only* honest way to notice either is to re-run the
 *      site periodically. That is what this clause is, and the run it triggers
 *      is cheap by construction: the horizon is bounded and the planner writes
 *      nothing when no fingerprint moved.
 *
 * A site with no revenue objects and no hints is never returned, so the sweep
 * costs nothing on an installation with no revenue connections. Dropping the
 * kind filter does not widen that set at all: a site with a refund necessarily
 * holds the charge the refund points at, so the same sites are returnable — only
 * *when* they are returned moves.
 *
 * Ordered by site id and bounded, for the projection loop's reason: an arbitrary
 * order would make a starved site's starvation depend on physical layout.
 */
export async function listSitesForRevenueAttribution(
  db: Executor,
  input: { readonly staleBefore: Date; readonly limit: number },
): Promise<string[]> {
  // NO `object_kind` filter (M12 CP7). A changed refund or dispute head must make
  // its site due exactly as a charge does: this pass owes both an attribution and
  // a rollup swap, and the swap's inputs are every kind. See trigger 1 above.
  const objectSites = await db
    .selectDistinct({ siteId: revenueObjects.siteId })
    .from(revenueObjects)
    .leftJoin(revenueAttributionState, eq(revenueAttributionState.siteId, revenueObjects.siteId))
    .where(
      or(
        isNull(revenueAttributionState.siteId),
        sql`${revenueObjects.updatedAt} > ${revenueAttributionState.computedThrough}`,
        lt(revenueAttributionState.computedThrough, input.staleBefore),
        // 4. A pending full-site rollup re-roll (CP5, migration 0037). Its own
        //    trigger rather than a consequence of the other three: a currency
        //    change does move every head's `updated_at`, so clause 2 fires
        //    once — but the marker survives a pass that ran before the
        //    re-projection landed, and without this clause nothing would bring
        //    the site back to finish the job.
        sql`${revenueAttributionState.rollupRecomputeFrom} IS NOT NULL`,
      ),
    )
    .orderBy(asc(revenueObjects.siteId))
    .limit(input.limit)

  const hintSites = await db
    .selectDistinct({ siteId: revenueMatchHints.siteId })
    .from(revenueMatchHints)
    .leftJoin(revenueAttributionState, eq(revenueAttributionState.siteId, revenueMatchHints.siteId))
    .where(
      or(
        isNull(revenueAttributionState.siteId),
        sql`${revenueMatchHints.updatedAt} > ${revenueAttributionState.computedThrough}`,
      ),
    )
    .orderBy(asc(revenueMatchHints.siteId))
    .limit(input.limit)

  const siteIds = new Set<string>()
  for (const row of objectSites) siteIds.add(row.siteId)
  for (const row of hintSites) siteIds.add(row.siteId)
  return [...siteIds].sort().slice(0, input.limit)
}

/**
 * The oldest watermark across every site that has one — the lag gauge's input.
 *
 * Sites with revenue but no control row yet are deliberately not counted: they
 * have no watermark to be behind, and discovery returns them on the very next
 * tick, so folding them in would report an unbounded lag for a site that is
 * about to be computed for the first time. `null` means no site has ever been
 * attributed, which the caller publishes as a zero rather than as an absence —
 * a series that exists only while work is pending cannot be told apart from a
 * loop that stopped running.
 */
export async function readOldestRevenueAttributionWatermark(db: Executor): Promise<Date | null> {
  const rows = await db
    .select({ oldest: sql<string | null>`min(${revenueAttributionState.computedThrough})` })
    .from(revenueAttributionState)

  const oldest = rows[0]?.oldest
  if (oldest === null || oldest === undefined) return null
  const parsed = new Date(oldest)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The earliest occurrence among charge heads that changed after `changedAfter`.
 *
 * This is the horizon's escape hatch and it exists for one scenario the rolling
 * window cannot cover on its own: a **deep backfill that lands after the
 * watermark has already moved**. D2e backfills 90 days on connect, and a
 * customer who connects Stripe, lets the attribution job run once, and then has
 * the backfill complete would otherwise have every charge older than
 * `window + lateness` sit unattributed forever — the rolling horizon would never
 * reach back to it and nothing would ever pull it forward.
 *
 * So the job asks this question once per due site and drops its horizon floor to
 * the answer when the answer is older. The read is scoped by
 * `(site_id, updated_at)` — the index migration 0034 created — so on the
 * ordinary tick it matches the handful of heads that moved since the last run,
 * and on the extraordinary one it matches the backfill.
 *
 * `occurred_at` is read out of the normalized snapshot rather than from a column
 * because there is no column: the head stores `snapshot_at` (when the provider
 * says this *observation* was taken) and the occurrence lives inside
 * `normalized`. The two are close for a charge and not identical, and the
 * horizon must be anchored on the value the fact is partitioned and queried by.
 */
/**
 * The earliest occurrence among heads of **any** kind that changed after
 * `changedAfter` — the rollup range's escape hatch (CP5).
 *
 * The charge-only version above is the ATTRIBUTION horizon's, and it is right to
 * be charge-only: only a charge owns a journey. The rollup's floor cannot be,
 * and a dispute is the case that proves it.
 *
 * A dispute is **one object whose status changes**, unlike a refund, which is a
 * separate object with its own occurrence. `charge.dispute.closed` therefore
 * bumps the dispute head and nothing else, while `occurred_at` stays the instant
 * the dispute was *opened*. Stripe's normal resolution time is sixty to ninety
 * days, so by the time a site wins a dispute the bucket that has to be rewritten
 * is far outside the thirty-one-day rolling horizon, and the charge-only hatch
 * cannot see the change at all. Without this read the bucket keeps
 * `dispute_withdrawn_minor` forever: the summary permanently understates while
 * the transactions list cheerfully shows the dispute as won.
 *
 * Used to lower the ROLLUP range floor only. It never touches the attribution
 * horizon — a dispute changes no journey, and widening that read would pull a
 * quarter of a site's session history in for a number that cannot move.
 */
export async function readOldestChangedRevenueObjectOccurrence(
  db: Executor,
  input: { readonly siteId: string; readonly changedAfter: Date },
): Promise<Date | null> {
  const rows = await db
    .select({
      oldest: sql<
        string | null
      >`min((${revenueObjects.normalized} ->> 'occurred_at')::timestamptz)`,
    })
    .from(revenueObjects)
    .where(
      and(
        eq(revenueObjects.siteId, input.siteId),
        sql`${revenueObjects.updatedAt} > ${input.changedAfter}`,
      ),
    )

  const oldest = rows[0]?.oldest
  if (oldest === null || oldest === undefined) return null
  const parsed = new Date(oldest)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export async function readOldestChangedRevenueChargeOccurrence(
  db: Executor,
  input: { readonly siteId: string; readonly changedAfter: Date },
): Promise<Date | null> {
  const rows = await db
    .select({
      oldest: sql<
        string | null
      >`min((${revenueObjects.normalized} ->> 'occurred_at')::timestamptz)`,
    })
    .from(revenueObjects)
    .where(
      and(
        eq(revenueObjects.siteId, input.siteId),
        eq(revenueObjects.objectKind, 'charge'),
        sql`${revenueObjects.updatedAt} > ${input.changedAfter}`,
      ),
    )

  const oldest = rows[0]?.oldest
  if (oldest === null || oldest === undefined) return null
  const parsed = new Date(oldest)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
