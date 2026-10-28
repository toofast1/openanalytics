"use client";

import {
  ArrowDown01Icon,
  ArrowRight02Icon,
  Globe02Icon,
  Target02Icon,
} from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { usePublishPosterSources } from "@/components/dashboard/poster-publishers";
import { Favicon } from "@/components/dashboard/site-favicon";
import {
  AnalyticsCardBody,
  breakdownShare,
  BreakdownRow,
} from "@/components/dashboard/analytics-card";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { HoverList } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import { useSourcesResource } from "@/components/dashboard/sources-resource";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import type { AnalyticsMeta, SourceRow } from "@/lib/api";
import { resolveAiUtm, resolveReferrer } from "@/lib/referrers";

/**
 * Acquisition, from `GET /v1/sites/{site_id}/analytics/sources`. The contract
 * row is the full tuple (referrer domain × utm source/medium/campaign); one
 * card shows one *dimension* of it at a time, picked in the header —
 * referrers by default, then the utm cuts. Mixing the dimensions into one
 * list conflated `utm_source=chatgpt.com` with the chatgpt.com referrer,
 * which are different statements about the same visit.
 *
 * Folding sums visitor counts across tuples, so a visitor who arrived under
 * two campaigns of one source counts twice in that row — a small, deliberate
 * over-count. The rows are ranked by that visitors figure all the same,
 * because it is the number the row shows: ranking by the exact views sum
 * underneath read 27, 2, 27, 18 down the list (Abbas, 2026-09-10). Views
 * stay on the row as the tie-break.
 *
 * The read itself is shared with the AI referrals card through
 * `SourcesProvider` (sources-resource.tsx): both fold the same response,
 * and the overview fetches it once.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type SourceView = "referrers" | "utm_campaign" | "utm_source" | "utm_medium";

const VIEWS: { id: SourceView; label: string; empty: string }[] = [
  {
    id: "referrers",
    label: "Referrers",
    empty: "No referrers in this range yet.",
  },
  {
    id: "utm_campaign",
    label: "Campaigns",
    empty: "No campaign-tagged visits in this range.",
  },
  {
    id: "utm_source",
    label: "UTM sources",
    empty: "No utm_source-tagged visits in this range.",
  },
  {
    id: "utm_medium",
    label: "UTM medium",
    empty: "No utm_medium-tagged visits in this range.",
  },
];

export type FoldedRow = {
  label: string;
  /** Canonical domain for the favicon — referrers view only. */
  domain: string | null;
  direct: boolean;
  views: number;
  visitors: number;
  /**
   * The raw `referrer_domain` values this row folded together, and what a
   * click filters by. The filter matches the canonical host exactly
   * (ADR-0075), and folding is by display name, which can merge more than
   * one host under one label; filtering by every host the row actually
   * holds is the only way the filtered numbers describe the row that was
   * clicked. Direct's raw value is the contract's own `""`.
   */
  raw: string[];
};

/** The referrer dimension: every row's domain, "" folding into Direct unless
 *  an assistant's UTM tag names the AI source (matching AI referrals). */
export function foldReferrers(items: SourceRow[]): FoldedRow[] {
  const byLabel = new Map<string, FoldedRow>();
  for (const row of items) {
    const referrer = row.referrer_domain
      ? resolveReferrer(row.referrer_domain)
      : null;
    const source = referrer ?? resolveAiUtm(row.utm_source, row.utm_medium);
    const label = source?.name ?? "Direct / none";
    const bucket = byLabel.get(label) ?? {
      label,
      domain: source?.domain ?? null,
      direct: source === null,
      views: 0,
      visitors: 0,
      raw: [],
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    if (
      (referrer !== null || source === null) &&
      !bucket.raw.includes(row.referrer_domain)
    ) {
      bucket.raw.push(row.referrer_domain);
    }
    byLabel.set(label, bucket);
  }
  return [...byLabel.values()].sort(byVisitors);
}

/** Ranked by the shown number, views breaking ties (see the file comment). */
function byVisitors(a: FoldedRow, b: FoldedRow): number {
  return b.visitors - a.visitors || b.views - a.views;
}

/** One utm dimension: tagged rows only — untagged traffic is not "(none)",
 *  it simply is not part of this cut. */
function foldUtm(
  items: SourceRow[],
  key: "utm_source" | "utm_medium" | "utm_campaign"
): FoldedRow[] {
  const byLabel = new Map<string, FoldedRow>();
  for (const row of items) {
    const value = row[key].trim();
    if (value === "") continue;
    const bucket = byLabel.get(value) ?? {
      label: value,
      domain: null,
      direct: false,
      views: 0,
      visitors: 0,
      raw: [],
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    byLabel.set(value, bucket);
  }
  return [...byLabel.values()].sort(byVisitors);
}

/** Favicon for a real referrer, the arrow for Direct, a target for utm. */
export function sourceMark(row: FoldedRow): React.ReactNode {
  if (row.domain !== null) {
    return (
      <Favicon
        key={row.domain}
        domain={row.domain}
        className="size-4 rounded-full border border-border/60 object-cover"
      />
    );
  }
  if (row.direct) {
    return <ArrowRight02Icon className="size-3.5 text-muted-foreground/70" />;
  }
  return <Target02Icon className="size-3.5 text-muted-foreground/70" />;
}

export function TopSourcesCard() {
  const { enabled, active, addFilter, hasValue } = useAnalyticsFilters();
  const resource = useSourcesResource();
  const [view, setView] = React.useState<SourceView>("referrers");
  const [open, setOpen] = React.useState(false);
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];

  // The referrer fold for the share poster, whatever cut the header shows:
  // the poster prints referrers, and the fold reads the same tuple list.
  const posterRows = React.useMemo(
    () =>
      resource.status === "ready"
        ? foldReferrers(resource.data.items).map((row) => ({
            label: row.label,
            domain: row.domain,
            direct: row.direct,
            visitors: row.visitors,
          }))
        : null,
    [resource]
  );
  usePublishPosterSources(
    posterRows,
    resource.status === "ready" && resource.data.meta.truncated
  );

  return (
    <>
    <SquircleCard
      onSeeAll={() => setOpen(true)}
      icon={<Globe02Icon aria-hidden="true" />}
      title={
        <DropdownMenu
          align="start"
          className="w-44"
          trigger={
            <button
              className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              {/* the house label swap — the title glides when the cut changes */}
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -9, opacity: 0, transition: { duration: 0.1 } }}
                  initial={{ y: 9, opacity: 0 }}
                  key={current.id}
                  transition={SPRING}
                >
                  {current.label}
                </motion.span>
              </AnimatePresence>
              <ArrowDown01Icon
                aria-hidden="true"
                className="!size-3.5 text-muted-foreground/70"
              />
            </button>
          }
        >
          {VIEWS.map((entry) => (
            <DropdownMenuItem key={entry.id} onClick={() => setView(entry.id)}>
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      }
    >
      <AnalyticsCardBody
        emptyBody={
          active
            ? "No visits match these filters."
            : "No referrers in this range yet."
        }
        isEmpty={(data) => data.items.length === 0}
        resource={resource}
      >
        {(data) => {
          const rows =
            view === "referrers"
              ? foldReferrers(data.items)
              : foldUtm(data.items, view);
          const share = breakdownShare(
            rows.map((row) => row.visitors),
            data.meta.truncated
          );
          return (
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="h-full"
                exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                initial={{ opacity: 0, y: 8 }}
                key={view}
                transition={SPRING}
              >
                {rows.length === 0 ? (
                  <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    {current.empty}
                  </p>
                ) : (
                  <SquircleCardScroll>
                    <HoverList>
                      {rows.map((row) => (
                        <BreakdownRow
                          icon={sourceMark(row)}
                          key={row.label}
                          name={row.label}
                          // Referrers only: the utm cuts have no filter
                          // dimension in v1, so their rows stay plain rows.
                          onSelect={
                            enabled &&
                            view === "referrers" &&
                            // Already filtered by every host this row folds:
                            // the press would add nothing, so the row does not
                            // offer one. Under a source filter this is most of
                            // the rows left standing.
                            !row.raw.every((domain) =>
                              hasValue("referrer_domain", domain)
                            )
                              ? () => {
                                  for (const domain of row.raw) {
                                    addFilter("referrer_domain", domain);
                                  }
                                }
                              : undefined
                          }
                          pct={share(row.visitors)}
                          value={row.visitors.toLocaleString("en-US")}
                        />
                      ))}
                    </HoverList>
                  </SquircleCardScroll>
                )}
              </motion.div>
            </AnimatePresence>
          );
        }}
      </AnalyticsCardBody>
    </SquircleCard>

    <AnimatePresence>
      {open && (
        <SourcesModal
          items={resource.status === "ready" ? resource.data.items : null}
          meta={resource.status === "ready" ? resource.data.meta : null}
          view={view}
          onClose={() => setOpen(false)}
        />
      )}
    </AnimatePresence>
    </>
  );
}

/** The whole ranking of the cut the card is on, in the vertical shell. */
function SourcesModal({
  items,
  meta,
  view,
  onClose,
}: {
  items: SourceRow[] | null;
  /** Read for `truncated` alone: a share of a capped row set is inflated. */
  meta: AnalyticsMeta | null;
  view: SourceView;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];
  const rows =
    items === null
      ? null
      : view === "referrers"
        ? foldReferrers(items)
        : foldUtm(items, view);
  const share = breakdownShare(
    rows === null ? [] : rows.map((row) => row.visitors),
    meta?.truncated ?? false
  );

  return (
    <SeeAllModal
      title={current.label}
      subtitle={`Where every visit came from · ${intervalLabel}`}
      onClose={onClose}
    >
      {rows === null ? (
        <SeeAllSkeleton />
      ) : rows.length === 0 ? (
        <p className="px-6 py-14 text-center text-sm text-muted-foreground">
          {current.empty}
        </p>
      ) : (
        // the shared white glide, rounded for the grey band
        <HoverList className="[&>li>span]:rounded-[10px]">
          {rows.map((row) => (
            <BreakdownRow
              icon={sourceMark(row)}
              key={row.label}
              name={row.label}
              pct={share(row.visitors)}
              value={row.visitors.toLocaleString("en-US")}
            />
          ))}
        </HoverList>
      )}
    </SeeAllModal>
  );
}
