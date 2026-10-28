import {
  SITE_DELETION_TARGETS,
  revenueObservationHash,
  type RevenueNormalizedObject,
  type RevenueObservation,
} from '@openanalytics/domain'
import {
  applyRevenueObservation,
  advanceRevenueRollupRecompute,
  createDatabase,
  createPool,
  createSiteWithOwner,
  claimRevenueAttributionSite,
  getRevenueAttributionState,
  isSiteFullyProjected,
  listDeletionTargets,
  listSitesForRevenueAttribution,
  listUnprojectedRevenueObjects,
  markRevenueObjectsProjected,
  markRevenueRollupRecompute,
  readOldestChangedRevenueChargeOccurrence,
  readOldestChangedRevenueObjectOccurrence,
  readOldestUnprojectedRevenueObjectUpdate,
  newId,
  resetRevenueProjection,
  startSiteDeletion,
  updateSiteSettings,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The reporting-currency writer and the full-site re-roll path (ADR-0033,
 * D2c/D7/D8; Postgres migration 0037). Milestone 12 Checkpoint 5.
 *
 * Five things only a real Postgres can answer, and each one is a place the
 * feature is wrong-but-plausible if it is not asserted:
 *
 * 1. **`resetRevenueProjection` bumps `version`.** CP3 shipped it without the
 *    bump and said so: a re-materialized fact TIED with the row it replaced, and
 *    `argMax` evaluated per column can then return a EUR label beside a USD
 *    amount. The assertion is that no head keeps its old version — an equal
 *    version is the fabricated-row hazard, and it is invisible in Postgres.
 * 2. **Both halves of a currency change commit together.** The projection reset
 *    and the rollup marker are written inside `updateSiteSettings`' own
 *    transaction, so a site whose facts and totals disagree cannot exist.
 * 3. **Re-sending the same currency is not a change.** A save button pressed
 *    twice must not rewrite every fact in ClickHouse.
 * 4. **The marker is cleared only when the projection has caught up.** This is
 *    the whole safety property: a rollup pass that arrives before the
 *    re-projection must leave the marker standing.
 * 5. **The registry is at its current count** and the two rollups are in it.
 *    The number itself moves with every milestone that adds a store, so the
 *    assertion below is the contract rather than this sentence.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

function normalized(overrides: Partial<RevenueNormalizedObject> = {}): RevenueNormalizedObject {
  return {
    object_kind: 'charge',
    status: 'succeeded',
    livemode: false,
    currency: 'eur',
    gross_minor: 4999,
    fee_minor: 0,
    net_minor: 4999,
    occurred_at: '2026-07-31T10:00:00.000Z',
    parent_object_id: '',
    order_id: 'pi_1',
    checkout_session_id: '',
    client_reference_id: '',
    subscription_id: '',
    product_id: '',
    product_name: '',
    customer_id: 'cus_1',
    ...overrides,
  } as RevenueNormalizedObject
}

function observation(objectId: string, at: string): RevenueObservation {
  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: new Date(at),
    normalized: normalized(),
  }
}

describeIfPostgres('reporting currency and the rollup re-roll marker', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m12cp5_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  const makeUser = async (): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `${id}@example.com`],
    )
    return id
  }

  const makeSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return siteId
  }

  /** An observation of an arbitrary kind, for the dispute case. */
  const applyKind = async (
    siteId: string,
    objectId: string,
    objectKind: 'charge' | 'refund' | 'dispute',
    snapshotAt: string,
    occurredAt: string,
  ) => {
    const obs: RevenueObservation = {
      objectId,
      objectKind,
      snapshotAt: new Date(snapshotAt),
      normalized: normalized({ object_kind: objectKind, occurred_at: occurredAt }),
    }
    return await applyRevenueObservation(db, {
      siteId,
      provider: 'stripe',
      observation: obs,
      payloadHash: revenueObservationHash(obs.normalized),
    })
  }

  const apply = async (siteId: string, objectId: string, at: string) => {
    const obs = observation(objectId, at)
    return await applyRevenueObservation(db, {
      siteId,
      provider: 'stripe',
      observation: obs,
      payloadHash: revenueObservationHash(obs.normalized),
    })
  }

  /** Every head's `(object_id, version, projected_version, projection_epoch)`. */
  const heads = async (siteId: string) => {
    const r = await pool.query<{
      object_id: string
      version: string
      projected_version: string
      projection_epoch: string
    }>(
      `SELECT object_id, version::text, projected_version::text, projection_epoch::text
         FROM revenue_objects WHERE site_id = $1 ORDER BY object_id`,
      [siteId],
    )
    return r.rows.map((row) => ({
      objectId: row.object_id,
      version: Number(row.version),
      projectedVersion: Number(row.projected_version),
      epoch: Number(row.projection_epoch),
    }))
  }

  const currencyOf = async (siteId: string): Promise<string> => {
    const r = await pool.query<{ c: string }>(
      `SELECT reporting_currency AS c FROM sites WHERE id = $1`,
      [siteId],
    )
    return r.rows[0]?.c ?? ''
  }

  const auditFor = async (siteId: string) => {
    const r = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE site_id = $1 AND action = 'site.settings.updated'
        ORDER BY occurred_at DESC, id DESC`,
      [siteId],
    )
    return r.rows.map((row) => row.metadata)
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()

    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })

    pool = createPool(scoped)
    db = createDatabase(pool)
    ownerId = await makeUser()
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  describe('resetRevenueProjection (CP3’s TODO(CP5), closed)', () => {
    it('bumps version so a restated fact SUPERSEDES rather than ties', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      // Two versions on the second head, so the bump is proven to be per row
      // rather than a flattening assignment.
      await apply(siteId, 'ch_2', '2026-07-31T10:00:00.000Z')
      await pool.query(
        `UPDATE revenue_objects SET version = 5, projected_version = 5
          WHERE site_id = $1 AND object_id = 'ch_2'`,
        [siteId],
      )
      await pool.query(
        `UPDATE revenue_objects SET projected_version = 1
          WHERE site_id = $1 AND object_id = 'ch_1'`,
        [siteId],
      )

      const before = await heads(siteId)
      const result = await resetRevenueProjection(db, { siteId })
      const after = await heads(siteId)

      expect(result.reset).toBe(2)
      for (const [index, head] of after.entries()) {
        const was = before[index]!
        // Strictly greater — an EQUAL version is the fabricated-row hazard, and
        // it is the one thing this whole checkpoint exists to remove.
        expect(head.version, head.objectId).toBe(was.version + 1)
        expect(head.version).toBeGreaterThan(was.version)
        // Due again, under a predicate with no clock in it.
        expect(head.projectedVersion).toBe(0)
        // And the epoch moved, so a batch that read these heads before the reset
        // cannot re-mark them as projected under the superseded currency.
        expect(head.epoch).toBe(was.epoch + 1)
      }
      // Relative versions are preserved: the bump is per row.
      expect(after[1]!.version - after[0]!.version).toBe(before[1]!.version - before[0]!.version)

      const due = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(due.map((row) => row.objectId).sort()).toEqual(['ch_1', 'ch_2'])
    })

    it('refuses a stale mark from a batch that read the heads before the reset', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      const [inFlight] = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(inFlight).toBeDefined()

      await resetRevenueProjection(db, { siteId })

      // The in-flight batch tries to mark what it projected. The epoch guard is
      // what refuses it.
      const marked = await markRevenueObjectsProjected(db, {
        marks: [
          {
            id: inFlight!.id,
            version: inFlight!.version,
            epoch: inFlight!.projectionEpoch,
          },
        ],
      })
      expect(marked.marked).toBe(0)
      expect((await heads(siteId))[0]?.projectedVersion).toBe(0)
    })
  })

  describe('the reporting-currency PATCH', () => {
    it('writes the currency, audits the change, and queues both halves', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      const before = await heads(siteId)

      const updated = await updateSiteSettings(db, {
        siteId,
        reportingCurrency: 'EUR',
        actorUserId: ownerId,
      })

      expect(updated.reportingCurrency).toBe('EUR')
      expect(updated.reportingCurrencyChanged).toBe(true)
      expect(await currencyOf(siteId)).toBe('EUR')

      // Half one: the facts are due again at a higher version.
      const after = await heads(siteId)
      expect(after[0]!.version).toBe(before[0]!.version + 1)
      expect(after[0]!.projectedVersion).toBe(0)

      // Half two: every bucket, not just those in the rolling horizon.
      const state = await getRevenueAttributionState(db, siteId)
      expect(state?.rollupRecomputeFrom?.getTime()).toBe(0)

      // The audit row names the value, which is the one field here whose value
      // matters: "who restated this site's revenue, when, and into what".
      const [entry] = await auditFor(siteId)
      expect(entry?.['fields']).toEqual(['reporting_currency'])
      expect(entry?.['reporting_currency']).toBe('EUR')
      expect(entry?.['reporting_currency_from']).toBe('USD')
      expect(entry?.['reporting_currency_changed']).toBe(true)
    })

    it('does NOT re-materialize when the currency is re-sent unchanged', async () => {
      // A save button pressed twice must not rewrite every fact in ClickHouse.
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      await markRevenueObjectsProjected(db, {
        marks: (await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).map((row) => ({
          id: row.id,
          version: row.version,
          epoch: row.projectionEpoch,
        })),
      })
      const before = await heads(siteId)

      const updated = await updateSiteSettings(db, {
        siteId,
        reportingCurrency: 'USD',
        actorUserId: ownerId,
      })

      expect(updated.reportingCurrencyChanged).toBe(false)
      expect(await heads(siteId)).toEqual(before)
      expect((await getRevenueAttributionState(db, siteId))?.rollupRecomputeFrom ?? null).toBeNull()
    })

    it('does not bump config_version — the collector has never heard of it', async () => {
      const siteId = await makeSite()
      const r0 = await pool.query<{ v: number }>(
        `SELECT config_version AS v FROM sites WHERE id = $1`,
        [siteId],
      )
      await updateSiteSettings(db, { siteId, reportingCurrency: 'GBP', actorUserId: ownerId })
      const r1 = await pool.query<{ v: number }>(
        `SELECT config_version AS v FROM sites WHERE id = $1`,
        [siteId],
      )
      expect(r1.rows[0]?.v).toBe(r0.rows[0]?.v)
    })

    it('changes the currency of a site that has never ingested revenue', async () => {
      // There is no control row yet, so the marker upsert has to create one —
      // and its `computed_through` stays the epoch, which is exactly right.
      const siteId = await makeSite()
      await updateSiteSettings(db, { siteId, reportingCurrency: 'JPY', actorUserId: ownerId })
      const state = await getRevenueAttributionState(db, siteId)
      expect(state?.rollupRecomputeFrom?.getTime()).toBe(0)
      expect(state?.computedThrough.getTime()).toBe(0)
    })
  })

  describe('the re-roll cursor (migration 0037)', () => {
    it('keeps the OLDER floor when marked twice', async () => {
      const siteId = await makeSite()
      await markRevenueRollupRecompute(db, { siteId, from: new Date('2026-07-01T00:00:00.000Z') })
      await markRevenueRollupRecompute(db, { siteId, from: new Date('2026-07-20T00:00:00.000Z') })
      const state = await getRevenueAttributionState(db, siteId)
      expect(state?.rollupRecomputeFrom?.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    })

    it('refuses to advance while any head is still unprojected', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      await markRevenueRollupRecompute(db, { siteId, from: new Date(0) })

      expect(
        await advanceRevenueRollupRecompute(db, {
          siteId,
          to: null,
          onlyIfWasProjected: true,
        }),
      ).toBe(false)
      expect((await getRevenueAttributionState(db, siteId))?.rollupRecomputeFrom?.getTime()).toBe(0)
    })

    it('refuses to advance when the pass began with the projection behind', async () => {
      // B2, the half a `NOT EXISTS` at advance time cannot see. The projection
      // finished DURING the pass, so the advance-time check is clean — but the
      // facts this pass read were the pre-restatement ones.
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      await markRevenueRollupRecompute(db, { siteId, from: new Date(0) })

      // t0: the pass looks, and the projection is behind.
      const projectedBeforeRead = await isSiteFullyProjected(db, siteId)
      expect(projectedBeforeRead).toBe(false)

      // t1..t2: the pass reads facts and rolls them up (elided).
      // t3: the projection catches up, mid-pass.
      await markRevenueObjectsProjected(db, {
        marks: (await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).map((row) => ({
          id: row.id,
          version: row.version,
          epoch: row.projectionEpoch,
        })),
      })
      expect(await isSiteFullyProjected(db, siteId)).toBe(true)

      // t4: the advance. Its own NOT EXISTS is now satisfied, and the cursor
      // must STILL not move — the numbers this pass wrote are stale.
      expect(
        await advanceRevenueRollupRecompute(db, {
          siteId,
          to: null,
          onlyIfWasProjected: projectedBeforeRead,
        }),
      ).toBe(false)
      expect((await getRevenueAttributionState(db, siteId))?.rollupRecomputeFrom?.getTime()).toBe(0)

      // The next pass begins with a quiet projection and completes the job.
      expect(
        await advanceRevenueRollupRecompute(db, {
          siteId,
          to: null,
          onlyIfWasProjected: await isSiteFullyProjected(db, siteId),
        }),
      ).toBe(true)
      expect((await getRevenueAttributionState(db, siteId))?.rollupRecomputeFrom ?? null).toBeNull()
    })

    it('walks the cursor forward one chunk at a time', async () => {
      const siteId = await makeSite()
      await markRevenueRollupRecompute(db, { siteId, from: new Date('2026-01-01T00:00:00.000Z') })

      for (const next of ['2026-02-01T00:00:00.000Z', '2026-03-04T00:00:00.000Z']) {
        expect(
          await advanceRevenueRollupRecompute(db, {
            siteId,
            to: new Date(next),
            onlyIfWasProjected: true,
          }),
        ).toBe(true)
        expect(
          (await getRevenueAttributionState(db, siteId))?.rollupRecomputeFrom?.toISOString(),
        ).toBe(next)
      }
    })

    it('never moves the cursor backwards', async () => {
      // Belt and braces against a pass that computed its chunk from a stale read.
      const siteId = await makeSite()
      await markRevenueRollupRecompute(db, { siteId, from: new Date('2026-06-01T00:00:00.000Z') })
      expect(
        await advanceRevenueRollupRecompute(db, {
          siteId,
          to: new Date('2026-05-01T00:00:00.000Z'),
          onlyIfWasProjected: true,
        }),
      ).toBe(false)
      expect(
        (await getRevenueAttributionState(db, siteId))?.rollupRecomputeFrom?.toISOString(),
      ).toBe('2026-06-01T00:00:00.000Z')
    })

    it('clears once a chunk reaches the rolling horizon', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      await markRevenueRollupRecompute(db, { siteId, from: new Date(0) })
      await markRevenueObjectsProjected(db, {
        marks: (await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).map((row) => ({
          id: row.id,
          version: row.version,
          epoch: row.projectionEpoch,
        })),
      })

      expect(
        await advanceRevenueRollupRecompute(db, { siteId, to: null, onlyIfWasProjected: true }),
      ).toBe(true)
      expect((await getRevenueAttributionState(db, siteId))?.rollupRecomputeFrom ?? null).toBeNull()
      // Idempotent: a second advance reports that it did nothing.
      expect(
        await advanceRevenueRollupRecompute(db, { siteId, to: null, onlyIfWasProjected: true }),
      ).toBe(false)
    })

    it('makes the site discoverable even with a fresh watermark', async () => {
      // Without this clause nothing would bring the site back to finish a walk a
      // pass left half done: a currency change moves every head's `updated_at`
      // once, and a pass that ran before the re-projection would advance past it.
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      await pool.query(
        `INSERT INTO revenue_attribution_state (site_id, computed_through)
         VALUES ($1, now()) ON CONFLICT (site_id) DO UPDATE SET computed_through = now()`,
        [siteId],
      )
      await pool.query(
        `UPDATE revenue_objects SET updated_at = now() - interval '1 day' WHERE site_id = $1`,
        [siteId],
      )

      const staleBefore = new Date(Date.now() - 60_000)
      expect(await listSitesForRevenueAttribution(db, { staleBefore, limit: 50 })).not.toContain(
        siteId,
      )

      await markRevenueRollupRecompute(db, { siteId, from: new Date(0) })
      expect(await listSitesForRevenueAttribution(db, { staleBefore, limit: 50 })).toContain(siteId)
    })
  })

  describe('the swap generation counter (migration 0037)', () => {
    it('gives every claim a distinct, increasing generation', async () => {
      // S4. The lease is five minutes and nothing renews it, so a long pass runs
      // beside the worker that took its lease. `max(stored) + 1` would give them
      // the same number from the same stored state — the one tie
      // ReplacingMergeTree cannot resolve.
      const siteId = await makeSite()
      const first = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'worker-1',
        leaseTtlMs: 60_000,
      })
      expect(first?.rollupGenerationSeq).toBe(1)

      // The lease expires and a second worker takes it.
      await pool.query(
        `UPDATE revenue_attribution_state SET lease_expires_at = now() - interval '1 minute'
          WHERE site_id = $1`,
        [siteId],
      )
      const thief = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'worker-2',
        leaseTtlMs: 60_000,
      })
      expect(thief?.rollupGenerationSeq).toBe(2)
      expect(thief?.rollupGenerationSeq as number).toBeGreaterThan(
        first?.rollupGenerationSeq as number,
      )
    })

    it('gives a loser no generation at all', async () => {
      const siteId = await makeSite()
      const winner = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'worker-1',
        leaseTtlMs: 300_000,
      })
      expect(winner).not.toBeNull()
      // The lease is live and held by somebody else: the conflict predicate
      // matches nothing, so no row and no counter bump.
      expect(
        await claimRevenueAttributionSite(db, {
          siteId,
          claimedBy: 'worker-2',
          leaseTtlMs: 300_000,
        }),
      ).toBeNull()
      expect((await getRevenueAttributionState(db, siteId))?.rollupGenerationSeq).toBe(1)
    })
  })

  describe('the rollup floor sees objects the attribution horizon cannot (B3)', () => {
    it('finds a dispute that closed long after it opened, where the charge hatch cannot', async () => {
      // Stripe resolves disputes in sixty to ninety days, and a dispute is ONE
      // object whose status changes — `charge.dispute.closed` bumps only the
      // dispute head while `occurred_at` stays the day it opened. Without the
      // widened read the bucket keeps `dispute_withdrawn_minor` forever while
      // the transactions list shows the dispute as won.
      const siteId = await makeSite()
      const opened = '2026-04-01T10:00:00.000Z'
      await applyKind(siteId, 'dp_1', 'dispute', opened, opened)

      // Everything is quiet as of the watermark.
      const watermark = new Date()
      expect(
        await readOldestChangedRevenueObjectOccurrence(db, { siteId, changedAfter: watermark }),
      ).toBeNull()

      // The dispute closes today. Only the dispute head moves.
      await pool.query(
        `UPDATE revenue_objects SET updated_at = now(), version = version + 1
          WHERE site_id = $1 AND object_id = 'dp_1'`,
        [siteId],
      )

      // The charge-only hatch the ATTRIBUTION horizon uses sees nothing...
      expect(
        await readOldestChangedRevenueChargeOccurrence(db, { siteId, changedAfter: watermark }),
      ).toBeNull()
      // ...while the rollup's widened read finds the bucket that must be rebuilt.
      const floor = await readOldestChangedRevenueObjectOccurrence(db, {
        siteId,
        changedAfter: watermark,
      })
      expect(floor?.toISOString()).toBe(opened)
    })
  })

  describe('discovery notices a changed head of ANY kind (M12 CP7 defect 2)', () => {
    /**
     * The production defect, at the exact line it lived on.
     * `listSitesForRevenueAttribution` filtered `object_kind = 'charge'`, which
     * was right when CP4 wrote it — the pass only attributed, and only a charge
     * owns a journey. CP5 gave the same pass the rollup swap, whose inputs are
     * refunds and disputes too, and did not widen the predicate. A refund at
     * 00:21 therefore sat in an un-rebuilt bucket until an unrelated charge at
     * 00:32 dragged the site back in.
     */
    const settle = async (siteId: string): Promise<Date> => {
      // A watermark strictly after every head, so nothing is due — the state a
      // quiet site is in between passes.
      const at = new Date()
      await pool.query(
        `INSERT INTO revenue_attribution_state (site_id, computed_through)
         VALUES ($1, $2) ON CONFLICT (site_id) DO UPDATE SET computed_through = $2`,
        [siteId, at],
      )
      return at
    }

    it('returns a site whose only changed head is a REFUND', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_1', '2026-07-31T10:00:00.000Z')
      await applyKind(
        siteId,
        're_1',
        'refund',
        '2026-07-31T10:05:00.000Z',
        '2026-07-31T10:05:00.000Z',
      )
      const watermark = await settle(siteId)

      // Quiet: nothing has moved since the watermark.
      const staleBefore = new Date(watermark.getTime() - 60_000)
      expect(await listSitesForRevenueAttribution(db, { staleBefore, limit: 50 })).not.toContain(
        siteId,
      )

      // The refund head moves — a `refund.updated`, or the refund arriving at
      // all. No charge is touched.
      await pool.query(
        `UPDATE revenue_objects SET updated_at = now() WHERE site_id = $1 AND object_id = 're_1'`,
        [siteId],
      )

      expect(await listSitesForRevenueAttribution(db, { staleBefore, limit: 50 })).toContain(siteId)
    })

    it('returns a site whose only changed head is a DISPUTE closing', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_2', '2026-05-01T10:00:00.000Z')
      await applyKind(
        siteId,
        'dp_1',
        'dispute',
        '2026-05-01T11:00:00.000Z',
        '2026-05-01T11:00:00.000Z',
      )
      const watermark = await settle(siteId)
      const staleBefore = new Date(watermark.getTime() - 60_000)
      expect(await listSitesForRevenueAttribution(db, { staleBefore, limit: 50 })).not.toContain(
        siteId,
      )

      // `charge.dispute.closed` bumps the dispute head and nothing else.
      await pool.query(
        `UPDATE revenue_objects SET updated_at = now(), version = version + 1
          WHERE site_id = $1 AND object_id = 'dp_1'`,
        [siteId],
      )

      expect(await listSitesForRevenueAttribution(db, { staleBefore, limit: 50 })).toContain(siteId)
    })

    it('still returns a site whose charge changed, and still ignores a quiet one', async () => {
      // The regression guard: widening the predicate must not have cost the
      // trigger it already had, nor made the sweep return everything.
      const changed = await makeSite()
      const quiet = await makeSite()
      await apply(changed, 'ch_3', '2026-07-31T10:00:00.000Z')
      await apply(quiet, 'ch_4', '2026-07-31T10:00:00.000Z')
      const watermark = await settle(changed)
      await settle(quiet)
      const staleBefore = new Date(watermark.getTime() - 60_000)

      await pool.query(
        `UPDATE revenue_objects SET updated_at = now() WHERE site_id = $1 AND object_id = 'ch_3'`,
        [changed],
      )

      const due = await listSitesForRevenueAttribution(db, { staleBefore, limit: 50 })
      expect(due).toContain(changed)
      expect(due).not.toContain(quiet)
    })
  })

  describe('the watermark ceiling: the oldest head the projection has not reached', () => {
    /**
     * The fresh-connection defect. A pass that read its facts before the
     * projection copied the backfill's heads, and advanced past their
     * `updated_at`, left nothing to rediscover the site: marking a head projected
     * moves `projected_version`, never `updated_at`.
     */
    it('answers the oldest unprojected update, then null once projected', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_w1', '2026-07-31T10:00:00.000Z')
      await apply(siteId, 'ch_w2', '2026-07-31T11:00:00.000Z')
      await pool.query(
        `UPDATE revenue_objects SET updated_at = CASE object_id
           WHEN 'ch_w1' THEN '2026-07-31T12:00:00Z'::timestamptz
           ELSE '2026-07-31T12:05:00Z'::timestamptz END
         WHERE site_id = $1`,
        [siteId],
      )

      expect((await readOldestUnprojectedRevenueObjectUpdate(db, siteId))?.toISOString()).toBe(
        '2026-07-31T12:00:00.000Z',
      )

      await markRevenueObjectsProjected(db, {
        marks: (await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).map((row) => ({
          id: row.id,
          version: row.version,
          epoch: row.projectionEpoch,
        })),
      })
      expect(await readOldestUnprojectedRevenueObjectUpdate(db, siteId)).toBeNull()
    })
  })

  describe('the deletion registry at its milestone end state (D8)', () => {
    it('snapshots 62 targets including both revenue rollups', async () => {
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })

      expect(SITE_DELETION_TARGETS).toHaveLength(62)
      // 62, not 63: `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(62)
      const clickhouse = targets.filter((t) => t.store === 'clickhouse').map((t) => t.target)
      expect(clickhouse).toHaveLength(34)
      // A vocabulary name with no purge statement verifies silently at
      // `deleted: 0`, so the names are asserted rather than only the count.
      // `revenue_1h` left with ClickHouse migration 0029 (v0.8.0).
      expect(clickhouse).not.toContain('revenue_1h')
      expect(clickhouse).toContain('revenue_1d')
      expect(clickhouse).toContain('revenue_15m')
      expect(targets.filter((t) => t.store === 'postgres')).toHaveLength(22)
      expect(targets.filter((t) => t.store === 'redis')).toHaveLength(5)
      expect(targets.filter((t) => t.store === 'object')).toHaveLength(1)
    })
  })
})
