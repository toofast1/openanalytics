"use client";

import { CoinsDollarIcon, DollarCircleIcon } from "hugeicons-react";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";
import { useSiteAnalytics } from "@/components/dashboard/analytics-card";
import { anonName } from "@/components/dashboard/anon-identity";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { relativeTime } from "@/components/dashboard/data-state";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { RecentVisitorModal } from "@/components/dashboard/realtime-board";
import { JourneyDialog } from "@/components/dashboard/revenue-transactions";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import { FlagIcon, MarkCircle } from "@/components/dashboard/tech-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { SquircleCard } from "@/components/ui/squircle-card";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  errorCodeOf,
  getRecentVisitors,
  LIVE_API,
  resolveSiteSlugCached,
  revenue,
  type AnalyticsRange,
  type RecentVisitor,
  type RevenueConnectionState,
  type RevenueSummaryResponse,
  type RevenueTotals,
  type RevenueTransaction,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { MOCK_REVENUE_SUMMARY } from "@/lib/mock";

/**
 * Revenue on the overview grid (M12, ADR-0033; frontend_tasks §23).
 *
 * **The empty states are the panel, not an edge case it also handles.** One
 * field decides which one you get — `meta.revenue.connection_status` — and a
 * zero is never allowed to stand in for any of them:
 *
 * - `not_connected` — nothing here is a number about this site, so the card
 *   shows a door rather than a `0`.
 * - `connected` with zero totals — the one real zero: no sales in this range.
 * - `degraded` — a warning **and** the figures. Blanking the card or showing
 *   zero during a provider outage is the exact failure this milestone was
 *   built to prevent: £0 is a claim about the business, and an outage is a
 *   claim about the pipe.
 * - `disconnected` — the recorded history, labelled as history.
 *
 * **Owner-only, gated on the role rather than on a probe.** `revenue:read` is
 * owner-only and an admin gets a 403 on all four reads, so the card is not
 * rendered for them at all — letting the 403 decide would flash an error on
 * every admin's dashboard load, once per visit, forever.
 *
 * Money is integer minor units plus a currency and nothing is pre-divided:
 * the average order value is `charge_gross_minor / charge_count`, computed
 * here, and `formatMoney` scales by the currency's own exponent because a
 * minor unit is not always a hundredth.
 */

/** The four totals that make up `net`, in the order the identity reads. */
function identityRows(totals: RevenueTotals): Array<{
  label: string;
  value: string;
  hint?: string;
}> {
  const money = (minor: number) => formatMoney(minor, totals.currency);
  const rows = [
    {
      label: "Gross",
      value: money(totals.charge_gross_minor),
      // The trap the contract names first: a refunded charge is here in full,
      // and the refund carries the negative in its own row below. Deducting
      // on both sides removes the money twice.
      hint: `${totals.charge_count} ${totals.charge_count === 1 ? "charge" : "charges"}`,
    },
    {
      label: "Refunds",
      value: `−${money(totals.refund_minor)}`,
      hint: `${totals.refund_count} ${totals.refund_count === 1 ? "refund" : "refunds"}`,
    },
  ];

  // Disputes are two columns on purpose, and a won dispute is in both — its
  // net effect is zero while the event stays visible. Showing the withdrawn
  // figure alone would report a dispute the site *won* as money lost, so the
  // row is the difference and the count says how many there were.
  if (totals.dispute_count > 0) {
    const netDispute =
      totals.dispute_withdrawn_minor - totals.dispute_reinstated_minor;
    rows.push({
      label: "Disputes",
      value: netDispute === 0 ? money(0) : `−${money(netDispute)}`,
      hint:
        netDispute === 0
          ? `${totals.dispute_count} raised, none held`
          : `${totals.dispute_count} ${totals.dispute_count === 1 ? "dispute" : "disputes"}`,
    });
  }

  rows.push({
    label: "Fees",
    value: `−${money(totals.fee_minor)}`,
    hint: "provider",
  });

  return rows;
}

export function RevenueCard() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";

  const summary = useSiteAnalytics(revenue.summary, MOCK_REVENUE_SUMMARY);

  /**
   * The summary's understudy, racing it. On a not-connected site the
   * summary read is the grid's slowest — the server does its range work
   * only to answer "no provider" in the meta — while the connection read
   * is a row lookup. Whichever lands first decides: `not_connected` from
   * here opens the Connect door immediately; anything else changes nothing
   * and the summary reveals the card exactly as before. This read can only
   * ever make the card earlier, never later — reveal never waits on it.
   */
  const loadState = React.useCallback(
    async (): Promise<RevenueConnectionState | null> => {
      // Mock mode plays the summary fixture's connected story; the race
      // would put the door over it.
      if (!LIVE_API) return null;
      const { site_id } = await resolveSiteSlugCached(slug);
      return revenue.state(site_id).catch(() => null);
    },
    [slug]
  );
  const state = useApiResource(loadState);
  const fastDoor =
    state.status === "ready" && state.data?.status === "not_connected";

  /**
   * A cosmetic pulse on interval change. The Connect door depends on no
   * range, so once `fastDoor` held, switching intervals left this card
   * frozen-revealed while every neighbour dipped into its skeleton — one
   * still card in a rippling grid read as stuck, not as fast. The door
   * still never waits for the summary; it just joins the wave for a beat.
   */
  const { range } = useAnalyticsInterval();
  const rangeKey = `${range.from}|${range.to}`;
  const seenRangeKey = React.useRef<string | null>(null);
  const [pulsing, setPulsing] = React.useState(false);
  // The /revenue page's fate is undecided (2026-08-09), so nothing links to
  // it any more: "See all" opens the paying-visitors modal instead — the
  // realtime board's people, filtered to the rows the wire gave money to.
  // Declared here, above the owner gate's early return, as hooks must be.
  const [listOpen, setListOpen] = React.useState(false);
  React.useEffect(() => {
    if (seenRangeKey.current === null) {
      // First render is the real load — the race and the summary own it.
      seenRangeKey.current = rangeKey;
      return;
    }
    if (seenRangeKey.current === rangeKey) return;
    seenRangeKey.current = rangeKey;
    // The timer hop is the house rule: an effect body may not setState
    // synchronously.
    const on = setTimeout(() => setPulsing(true), 0);
    const off = setTimeout(() => setPulsing(false), 550);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, [rangeKey]);

  // Nothing ever for anyone but the owner. But while the role is still being
  // learned, the card is *drawn*, at full anatomy with its content standing
  // in: the person opening a site's overview is almost always its owner, and
  // a card that waited to exist left its slot to the countries card and then
  // shoved the whole grid when it arrived. The rare non-owner answer folds
  // one card away once — the gentler failure, and the same trade every
  // maybe-panel in settings now makes.
  //
  // The role is read off the summary itself: `revenue:read` is owner-only,
  // so a non-owner's read answers 403 and that IS the role check. The card
  // used to fetch the site beside the summary just to ask it, and revealing
  // meant waiting for whichever of the two came last — this card was
  // reliably the grid's straggler for a request whose answer the summary
  // already carried.
  if (
    summary.status === "error" &&
    errorCodeOf(summary.error) === "FORBIDDEN"
  ) {
    return null;
  }

  const settled = !pulsing && (fastDoor || summary.status !== "loading");

  return (
    <>
    <SquircleCard
      title="Revenue"
      icon={<DollarCircleIcon aria-hidden="true" />}
      onSeeAll={() => setListOpen(true)}
    >
      <SkeletonReveal
        className="h-full [&>div]:h-full"
        ready={settled}
        skeleton={
          <div className="flex h-full flex-col justify-center gap-2 px-4">
            <SkeletonBar className="h-6 w-28 rounded-md" />
            <SkeletonBar className="h-3 w-40 rounded-md" />
          </div>
        }
      >
        {!settled ? null : fastDoor && summary.status !== "ready" ? (
          // The connection read answered first: the door needs no totals.
          // When the summary catches up it renders the same door (or, in a
          // race across a connect, the numbers) in place — no re-reveal.
          <ConnectDoor slug={slug} />
        ) : (
          <RevenueBody resource={summary} slug={slug} />
        )}
      </SkeletonReveal>
    </SquircleCard>

    <AnimatePresence>
      {listOpen ? (
        <PayingVisitorsModal
          onClose={() => setListOpen(false)}
          range={range}
          slug={slug}
        />
      ) : null}
    </AnimatePresence>
    </>
  );
}

interface PayingRow {
  id: string;
  avatarSeed: string;
  title: string;
  subtitle: string;
  amount_minor: number;
  currency: string;
  occurred_at: string | null;
  country: string | null;
  visitor?: RecentVisitor;
  transaction?: RevenueTransaction;
}

/**
 * The card's "See all": lists the paying visitors and transactions for the
 * currently selected dashboard interval (`range`), while matching against
 * real-time visitors for full hero-identity contexts when available.
 *
 * Clicking a row opens either their hero-identity journey modal (`RecentVisitorModal`)
 * or the transaction purchase journey dialog (`JourneyDialog`), answering both
 * "who paid" and "where did they come from / what pages did they read" without
 * leaving the overview dashboard.
 */
function PayingVisitorsModal({
  slug,
  range,
  onClose,
}: {
  slug: string;
  range: AnalyticsRange;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const [siteId, setSiteId] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<PayingRow[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [selectedVisitor, setSelectedVisitor] =
    React.useState<RecentVisitor | null>(null);
  const [selectedTransaction, setSelectedTransaction] =
    React.useState<RevenueTransaction | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      if (!LIVE_API) {
        setRows(
          MOCK_PAYING_VISITORS.map((mv) => ({
            id: mv.visitor,
            avatarSeed: mv.visitor,
            title: anonName(mv.visitor),
            subtitle:
              mv.pageviews > 0
                ? `${mv.pageviews} ${mv.pageviews === 1 ? "page" : "pages"}`
                : "payment only",
            amount_minor: mv.revenue!.amount_minor,
            currency: mv.revenue!.currency,
            occurred_at: mv.last_seen,
            country: mv.country,
            visitor: mv,
          }))
        );
        return;
      }
      try {
        const { site_id } = await resolveSiteSlugCached(slug);
        if (cancelled) return;
        setSiteId(site_id);
        const timezone =
          Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

        // Query both in parallel: transactions for the selected range (e.g. yesterday,
        // last 7 days, etc.), and recent visitors for the trailing 24h hero identity context.
        const [txResult, rvResult] = await Promise.allSettled([
          revenue.transactions(site_id, range, {
            signal: controller.signal,
          }),
          getRecentVisitors(
            site_id,
            { hours: 24, timezone },
            { signal: controller.signal }
          ),
        ]);

        if (cancelled) return;

        const transactions =
          txResult.status === "fulfilled" ? txResult.value.items : [];
        const recentVisitors =
          rvResult.status === "fulfilled"
            ? rvResult.value.items.filter((item) => item.revenue !== undefined)
            : [];

        const resultRows: PayingRow[] = [];
        const usedVisitors = new Set<string>();

        if (transactions.length > 0) {
          for (const tx of transactions) {
            const matchedRv = recentVisitors.find(
              (rv) =>
                !usedVisitors.has(rv.visitor) &&
                rv.revenue &&
                rv.revenue.amount_minor === tx.gross.amount_minor
            );
            if (matchedRv) {
              usedVisitors.add(matchedRv.visitor);
              resultRows.push({
                id: tx.object_id,
                avatarSeed: matchedRv.visitor,
                title: anonName(matchedRv.visitor),
                subtitle:
                  matchedRv.pageviews > 0
                    ? `${matchedRv.pageviews} ${matchedRv.pageviews === 1 ? "page" : "pages"}`
                    : (tx.product_name ?? "payment only"),
                amount_minor: tx.gross.amount_minor,
                currency: tx.gross.currency,
                occurred_at: tx.occurred_at,
                country: matchedRv.country,
                visitor: matchedRv,
                transaction: tx,
              });
            } else {
              resultRows.push({
                id: tx.object_id,
                avatarSeed: tx.object_id,
                title: tx.product_name ?? anonName(tx.object_id),
                subtitle:
                  tx.matched_via !== "none"
                    ? "attributed visit"
                    : "payment only",
                amount_minor: tx.gross.amount_minor,
                currency: tx.gross.currency,
                occurred_at: tx.occurred_at,
                country: null,
                transaction: tx,
              });
            }
          }
        } else if (recentVisitors.length > 0) {
          for (const rv of recentVisitors) {
            resultRows.push({
              id: rv.visitor,
              avatarSeed: rv.visitor,
              title: anonName(rv.visitor),
              subtitle:
                rv.pageviews > 0
                  ? `${rv.pageviews} ${rv.pageviews === 1 ? "page" : "pages"}`
                  : "payment only",
              amount_minor: rv.revenue!.amount_minor,
              currency: rv.revenue!.currency,
              occurred_at: rv.last_seen,
              country: rv.country,
              visitor: rv,
            });
          }
        }

        setRows(resultRows);
      } catch {
        if (!cancelled) setFailed(true);
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, range]);

  return (
    <>
      <SeeAllModal
        onClose={
          selectedVisitor !== null || selectedTransaction !== null
            ? () => {
                setSelectedVisitor(null);
                setSelectedTransaction(null);
              }
            : onClose
        }
        subtitle={`Visitors whose payments landed · ${intervalLabel}`}
        title="Paying visitors"
      >
        {failed ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            The list could not be loaded. Close this and try again.
          </p>
        ) : rows === null ? (
          <SeeAllSkeleton />
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            No attributed payments in {intervalLabel.toLowerCase()}. When one lands, the
            visitor who made it shows up here.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring sm:gap-2.5"
                  onClick={() => {
                    if (row.visitor) {
                      setSelectedTransaction(null);
                      setSelectedVisitor(row.visitor);
                    } else if (row.transaction) {
                      setSelectedVisitor(null);
                      setSelectedTransaction(row.transaction);
                    }
                  }}
                  type="button"
                >
                  <UserAvatar seed={row.avatarSeed} size={24} />
                  <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2">
                    <span className="truncate text-sm font-medium">
                      {row.title}
                    </span>
                    <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
                      {row.subtitle}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                    <Badge
                      className="shrink-0 tabular-nums"
                      icon={<CoinsDollarIcon />}
                      size="sm"
                      variant="success"
                    >
                      {formatMoney(row.amount_minor, row.currency)}
                    </Badge>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                      {relativeTime(row.occurred_at)}
                    </span>
                    {row.country ? (
                      <MarkCircle className="size-6 shrink-0">
                        <FlagIcon className="size-4" code={row.country} />
                      </MarkCircle>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SeeAllModal>

      <AnimatePresence>
        {selectedVisitor !== null ? (
          <div className="relative z-[70]">
            <RecentVisitorModal
              key={selectedVisitor.visitor}
              onBack={() => setSelectedVisitor(null)}
              onClose={onClose}
              slug={slug}
              visitor={selectedVisitor}
            />
          </div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {selectedTransaction !== null && siteId !== null ? (
          <div className="relative z-[70]">
            <JourneyDialog
              onClose={() => setSelectedTransaction(null)}
              range={range}
              siteId={siteId}
              transaction={selectedTransaction}
            />
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** Design-mode rows, in the wire's own shape: two believable payers. */
const MOCK_PAYING_VISITORS: RecentVisitor[] = [
  {
    visitor: "v_mock_payer_one",
    country: "DE",
    device_type: "desktop",
    browser: "chrome",
    os: "macos",
    first_seen: "2026-08-09T08:05:00.000Z",
    last_seen: "2026-08-09T08:41:00.000Z",
    pageviews: 6,
    revenue: { amount_minor: 2900, currency: "USD", transaction_count: 1 },
  },
  {
    visitor: "v_mock_payer_two",
    country: "US",
    device_type: "mobile",
    browser: "safari",
    os: "ios",
    first_seen: "2026-08-09T06:12:00.000Z",
    last_seen: "2026-08-09T06:19:00.000Z",
    pageviews: 0,
    revenue: { amount_minor: 900, currency: "USD", transaction_count: 1 },
  },
];

/** The not-connected state: a door to integrations, never a `0`. */
function ConnectDoor({ slug }: { slug: string }) {
  return (
    <div className="flex h-full flex-col items-start justify-center gap-2 px-4">
      <p className="text-sm leading-6 text-muted-foreground">
        Connect Stripe and the money lands beside the traffic that earned it,
        no numbers here until it does.
      </p>
      <Button
        render={
          <Link
            href={`/dashboard/${encodeURIComponent(slug)}/settings?tab=integrations`}
          >
            Connect a provider
          </Link>
        }
        size="sm"
        variant="outline"
      />
    </div>
  );
}

function RevenueBody({
  resource,
  slug,
}: {
  resource: ReturnType<typeof useSiteAnalytics<RevenueSummaryResponse>>;
  slug: string;
}) {
  if (resource.status === "error") {
    return (
      <ApiErrorPanel
        className="h-full gap-1 px-4 py-2 [&_p]:text-xs [&_p]:leading-5"
        error={resource.error}
        onRetry={resource.retry}
      />
    );
  }
  // Unreachable — the card holds this body back until the read settles, and
  // error returned above — but the narrowing is real.
  if (resource.status !== "ready") return null;

  const { totals, unconverted, meta } = resource.data;
  // `meta.revenue` is optional on the wire because it rides every analytics
  // response, not only this one. Absent means the deployment has no revenue
  // surface at all, which reads the same as never having connected.
  const status = meta.revenue?.connection_status ?? "not_connected";

  if (status === "not_connected") {
    return <ConnectDoor slug={slug} />;
  }

  const empty =
    totals.charge_count === 0 &&
    totals.refund_count === 0 &&
    totals.dispute_count === 0 &&
    totals.unconverted_count === 0;

  if (status === "connected" && empty) {
    return (
      <div className="flex h-full flex-col justify-center px-4">
        <p className="text-sm leading-6 text-muted-foreground">
          No sales in this range. The provider is connected and answering.
        </p>
      </div>
    );
  }

  const averageOrder =
    totals.charge_count > 0
      ? formatMoney(
          Math.round(totals.charge_gross_minor / totals.charge_count),
          totals.currency
        )
      : null;

  return (
    <div className="flex h-full flex-col gap-2 px-4 py-3">
      {/* The two states that still carry figures each owe the reader a
          sentence about *why* the figures might not be current. Neither
          blanks the card. */}
      {status === "degraded" ? (
        <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs leading-5 text-amber-700">
          Sync is failing. These figures are correct as of{" "}
          {relativeTime(meta.revenue?.last_synced_at ?? null) ?? "the last sync"}
          , not zero.
        </p>
      ) : null}
      {status === "disconnected" ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Provider disconnected: this is the recorded history. Nothing new
          arrives.
        </p>
      ) : null}

      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xl font-medium tabular-nums tracking-tight sm:text-2xl">
          {formatMoney(totals.net_minor, totals.currency)}
        </p>
        {averageOrder ? (
          <p className="text-xs text-muted-foreground">
            <span className="tabular-nums">{averageOrder}</span> avg. order
          </p>
        ) : null}
      </div>

      {/* Net alone hides the shape of the month. The parts are what tell a
          reader whether a flat figure is quiet trading or heavy refunds. */}
      <dl className="flex flex-col gap-1">
        {identityRows(totals).map((row) => (
          <div
            className="flex items-baseline justify-between gap-3 text-xs"
            key={row.label}
          >
            <dt className="text-muted-foreground">
              {row.label}
              {row.hint ? (
                <span className="text-muted-foreground/70"> · {row.hint}</span>
              ) : null}
            </dt>
            <dd className="tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      {/* Never silent, and never a loss: the remainder is an understatement
          by a knowable amount, so the amount is what gets printed. */}
      {totals.unconverted_count > 0 ? (
        <p className="mt-auto text-[11px] leading-4 text-muted-foreground">
          Plus{" "}
          {unconverted
            .map((entry) => formatMoney(entry.charge_gross_minor, entry.currency))
            .join(", ")}{" "}
          across {totals.unconverted_count}{" "}
          {totals.unconverted_count === 1 ? "transaction" : "transactions"} we
          could not convert.
        </p>
      ) : null}
    </div>
  );
}
