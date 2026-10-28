"use client";

import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  CoinsDollarIcon,
} from "hugeicons-react";
import { Badge } from "@/components/ui/badge";
import {
  REALTIME_SNAPSHOT_MAX_AGE_SECONDS,
  type RealtimePresentVisitor,
} from "@openanalytics/contracts";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { useParams } from "next/navigation";
import * as React from "react";
import { Favicon } from "@/components/dashboard/site-favicon";
import { anonName } from "@/components/dashboard/anon-identity";
import { timeAgo, useClockBucket } from "@/components/dashboard/realtime-clock";
import { RealtimeConnectionBanner } from "@/components/dashboard/realtime-status";
import { JourneyEntryRow } from "@/components/dashboard/revenue-transactions";
import {
  BrowserIcon,
  DeviceGlyph,
  FlagIcon,
  MarkCircle,
  OSIcon,
} from "@/components/dashboard/tech-icons";
import {
  SkeletonBar,
  SkeletonCircle,
  SkeletonReveal,
} from "@/components/ui/skeleton-reveal";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useRealtime } from "@/hooks/use-realtime";
import {
  getRecentVisitors,
  getVisitorTrail,
  LIVE_API,
  resolveSiteSlugCached,
  type RecentVisitor,
  type RevenueJourneyEntry,
  type VisitorRevenue,
  type VisitorSession,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { resolveReferrer } from "@/lib/referrers";

/**
 * The realtime page is just the list: one row per active anonymous visitor,
 * each opening the hero-identity modal, with presence's own count on the
 * Online heading. The connection banner still appears when the stream
 * degrades, because that is information, not chrome.
 *
 * **Identity here is D-102's rotating anonymous hash, never a person.** The
 * name and face are derived deterministically from that hash, so a visitor
 * is recognizable *within* a rotation window and unlinkable across them —
 * which is exactly the privacy promise the landing makes.
 *
 * **The Online rows are `snapshot.present`** — the visitors presence itself
 * says are here (ADR-0035), joined to `snapshot.events` (the rolling page-view
 * feed, ADR-0024) for the page history and referrer only the feed knows. Both
 * are rendered as they arrive and never accumulated client-side: every
 * snapshot fully supersedes the last, and that replacement IS the stream's
 * replay guarantee.
 *
 * Two things this replaced, both of which existed because presence could once
 * say how many and never who: rows derived by zipping the aggregate
 * breakdowns into imaginary visitors, and a client-side 60-second "online"
 * rule over the page-view feed that dropped a long reader out of the list
 * while they were heartbeating perfectly. The server owns the window now — a
 * visitor is here for five minutes after their last signal of any kind, and a
 * hidden tab stops signalling at once. `present` is bounded at 50, so on a
 * busier site the surplus still renders as a counted line.
 *
 * **Earlier and the modal's journey come from the api, not from watching
 * the stream** (the browser-witness trail store is retired):
 * `analytics/recent-visitors?hours=24` is the Earlier list, and
 * `analytics/visitor?hash=` is the session-by-session trail behind any row —
 * live and earlier rows share the same hash, so they open the same detail.
 * 24 is the contract's ceiling, and also the natural one: the hash rotates
 * at UTC midnight, so sessions past the rotation belong to a different hash
 * and no deeper window could attribute them to this row. Both reads are
 * provisional by contract; the trail refetches while the modal is open so
 * new pageviews surface at the top of the current session.
 */

/* ------------------------------------------------------------------ */
/* Feed shapes                                                         */
/* ------------------------------------------------------------------ */

/**
 * A feed event normalized for rendering: age instead of a wall-clock instant,
 * and the contract's nullable geo/UA labels collapsed to "unknown" — the value
 * the aggregate-derived rows already use, so both sources render the same way.
 */
type FeedEvent = {
  event_id: string;
  /** D-102 rotating anonymous visitor hash — the grouping key. */
  visitor: string;
  path: string;
  /** Two-letter code or "unknown". */
  country: string;
  device_type: string;
  browser: string | null;
  os: string | null;
  referrer: string | null;
  secondsAgo: number;
};

/** One anonymous visitor row — live (from the feed) or earlier (from the
 * recent-visitors read); both open the same detail by the same hash. */
type AnonVisitor = {
  hash: string;
  name: string;
  country: string;
  deviceType: string;
  browser: string | null;
  os: string | null;
  referrer: string | null;
  /**
   * The page presence last recorded for this visitor, for a row whose page
   * views have already aged off the feed — or who never had one (a heartbeat
   * with no page). Null for earlier rows, which state a pageview count instead.
   */
  currentPath: string | null;
  /** Most recent first; empty for rows the recent-visitors read produced. */
  events: FeedEvent[];
  /** Total page views over the trailing window — earlier rows only. */
  pageviews: number | null;
  secondsAgo: number;
  online: boolean;
};

export type VisitorModalTarget = {
  hash: string;
  name: string;
  country: string;
  deviceType: string;
  browser: string | null;
  os: string | null;
  currentPath: string | null;
  secondsAgo: number;
  online: boolean;
};

export type VisitorModalSession = {
  id: string;
  startedAtS: number;
  referrer: string | null;
  entries: Array<{ id: string; path: string; secondsAgo: number }>;
};

export function recentVisitorToModalTarget(
  item: RecentVisitor,
  nowS: number
): VisitorModalTarget {
  const lastSeenS = Math.floor(Date.parse(item.last_seen) / 1000);
  return {
    hash: item.visitor,
    name: anonName(item.visitor),
    country: item.country === "" ? "unknown" : item.country,
    deviceType: item.device_type === "" ? "unknown" : item.device_type,
    browser: item.browser === "" ? null : item.browser,
    os: item.os === "" ? null : item.os,
    currentPath: null,
    secondsAgo: Math.max(0, nowS - lastSeenS),
    online: false,
  };
}

export function visitorTrailToModalSessions(
  sessions: readonly VisitorSession[],
  nowS: number
): VisitorModalSession[] {
  return sessions.map((session, index) => ({
    id: session.session_id === "" ? `unattributed-${index}` : session.session_id,
    startedAtS: Math.floor(Date.parse(session.started_at) / 1000),
    referrer:
      session.pages.find((page) => page.referrer_domain !== "")
        ?.referrer_domain ?? null,
    // Pages arrive oldest-first; the card reads newest-first, so a
    // fresh pageview lands on top.
    entries: [...session.pages].reverse().map((page) => ({
      id: page.event_id,
      path: page.page_path,
      secondsAgo: Math.max(
        0,
        nowS - Math.floor(Date.parse(page.occurred_at) / 1000)
      ),
    })),
  }));
}

/**
 * The wall clock and the age vocabulary both moved to `realtime-clock.ts`
 * when the overview card started listing the same visitors this board does:
 * one clock and one phrasing, so a person is never "now" here and "12s ago"
 * there.
 */

/* Anonymous identity (name from hash) lives in anon-identity.ts — shared
   with the globe so the same hash is the same face everywhere. */

const DEVICE_LABEL: Record<string, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
  unknown: "Other",
};

/** Regional-indicator flag for an iso2 code; a globe for "unknown". */
/** "2:13 PM" — the session card's wall-clock stamp. */
function clockLabel(atS: number): string {
  return new Date(atS * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Wire labels arrive lowercase ("chrome", "windows") because the historical
 * devices report groups by the same values — casing them for display is
 * frontend work, and keeping the wire value untouched keeps the two joinable.
 */
const FAMILY_LABEL: Record<string, string> = { ios: "iOS", macos: "macOS" };
function familyLabel(value: string | null): string {
  if (value === null || value === "" || value === "unknown") return "—";
  return FAMILY_LABEL[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/* ------------------------------------------------------------------ */
/* Atoms — same chip language the old visitors list used               */
/* ------------------------------------------------------------------ */

/* Tab-bar tooltip language for the hero's tech marks: one persistent dark
   pill that glides between icons, the label sliding in from the direction
   the hover travels. Constants mirror tab-bar.tsx. */
const MARK_SPRING = { type: "spring", stiffness: 550, damping: 40 } as const;
const MARK_LABEL_EXIT_PX = 130;
const markLabelVariants = {
  enter: (dir: number) => ({ x: `${dir * 110}%` }),
  center: { x: "0%" },
  exit: (dir: number) => ({ x: dir * -MARK_LABEL_EXIT_PX }),
};

/** Icon-only tech row with the tab bar's gliding tooltip on hover. */
function TechMarks({
  items,
}: {
  items: Array<{ key: string; label: string; icon: React.ReactNode }>;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const [anchorX, setAnchorX] = React.useState(0);
  const [dir, setDir] = React.useState(1);
  const itemRefs = React.useRef<(HTMLElement | null)[]>([]);

  const enter = (index: number) => {
    const node = itemRefs.current[index];
    if (!node) return;
    if (hovered !== null && hovered !== index) {
      setDir(index > hovered ? 1 : -1);
    }
    setAnchorX(node.offsetLeft + node.offsetWidth / 2);
    setHovered(index);
  };

  const hoveredItem = hovered !== null ? items[hovered] : undefined;

  return (
    <div className="relative" onMouseLeave={() => setHovered(null)}>
      <AnimatePresence>
        {hoveredItem !== undefined ? (
          <motion.div
            animate={{ left: anchorX, x: "-50%", opacity: 1, scale: 1, y: 0 }}
            className="absolute bottom-full z-10 mb-2"
            exit={{
              opacity: 0,
              x: "-50%",
              scale: 0.9,
              y: 4,
              transition: { duration: 0.12 },
            }}
            initial={{ left: anchorX, x: "-50%", opacity: 0, scale: 0.85, y: 6 }}
            key="mark-tooltip"
            role="tooltip"
            transition={MARK_SPRING}
          >
            <motion.div
              className="overflow-hidden rounded-[12px] bg-[#1c1c1f] shadow-[0_1px_1px_rgba(0,0,0,0.3),0_8px_24px_rgba(0,0,0,0.35)] ring-1 ring-white/10"
              layout
              style={{ borderRadius: 12 }}
              transition={MARK_SPRING}
            >
              <AnimatePresence custom={dir} initial={false} mode="popLayout">
                <motion.span
                  animate="center"
                  className="block whitespace-nowrap px-3 py-[7px] text-[13px] font-medium text-white"
                  custom={dir}
                  exit="exit"
                  initial="enter"
                  key={hoveredItem.label}
                  transition={MARK_SPRING}
                  variants={markLabelVariants}
                >
                  {hoveredItem.label}
                </motion.span>
              </AnimatePresence>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex items-center justify-center gap-3">
        {items.map((item, index) => (
          <span
            key={item.key}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            onMouseEnter={() => enter(index)}
            className="flex items-center"
          >
            <MarkCircle className="size-8">{item.icon}</MarkCircle>
            <span className="sr-only">{item.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Referrer as a small chip, the source's real favicon in front of its
 *  household name — "Google", not "www.google.com" (journey card headers).
 *  Keyed by domain so the favicon's failed flag resets when a different
 *  referrer reuses the chip. */
function ReferrerInline({ entry }: { entry: string | null }) {
  const source = entry === null ? null : resolveReferrer(entry);
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-black/4 py-0.5 pl-1 pr-2.5">
      {source === null ? (
        <ArrowRight02Icon className="size-3 text-muted-foreground" />
      ) : (
        <Favicon
          key={source.domain}
          domain={source.domain}
          className="size-4.5 rounded-full border border-border/60 object-cover"
        />
      )}
      {source?.name ?? "Direct"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Modal choreography — verbatim from the original visitors screen     */
/* ------------------------------------------------------------------ */

/** Bouncy pop entrance for the modal panel. */
const POP_SPRING = { type: "spring", stiffness: 400, damping: 26 } as const;

/** Content choreography: blocks flip up into place like cards being dealt. */
const MODAL_CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } },
};
const MODAL_ITEM: Variants = {
  // The house language: a plain upward drift, no perspective flip — the
  // rotateX "card deal" read as a cube turning once real data streamed in.
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 380, damping: 28 },
  },
};

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

/**
 * The Online rows: one per visitor the snapshot says is **here**, joined to the
 * page-view feed for the things only the feed knows (ADR-0035, D3).
 *
 * The server decides who is online — a visitor is present for five minutes
 * after their last signal of any kind, and a hidden tab stops signalling at
 * once. There is deliberately no second window in the browser: the old
 * `ONLINE_WINDOW_S` derived "online" from the freshest *page view*, so a
 * visitor reading one page for two minutes fell out of this list while
 * heartbeating perfectly and became an anonymous `+1`.
 *
 * Presence carries the union of every label it has ever been told about a
 * visitor, so it leads; the feed fills in what presence does not store at all —
 * the page history and the referrer.
 */
function onlineVisitors(
  present: readonly RealtimePresentVisitor[],
  feed: FeedEvent[],
  nowS: number
): AnonVisitor[] {
  const feedByHash = new Map<string, FeedEvent[]>();
  for (const event of feed) {
    const bucket = feedByHash.get(event.visitor);
    if (bucket) bucket.push(event);
    else feedByHash.set(event.visitor, [event]);
  }

  return present.map((row) => {
    const events = (feedByHash.get(row.visitor) ?? []).sort(
      (a, b) => a.secondsAgo - b.secondsAgo
    );
    const latest = events[0];
    return {
      hash: row.visitor,
      name: anonName(row.visitor),
      country: row.country ?? latest?.country ?? "unknown",
      deviceType: row.device_type ?? latest?.device_type ?? "unknown",
      browser: row.browser ?? latest?.browser ?? null,
      os: row.os ?? latest?.os ?? null,
      // Presence stores no referrer — it is a property of an event, not of a
      // person — so this is the feed's alone.
      referrer: events.find((event) => event.referrer !== null)?.referrer ?? null,
      currentPath: row.path ?? latest?.path ?? null,
      events,
      pageviews: null,
      secondsAgo: Math.max(
        0,
        nowS - Math.floor(Date.parse(row.last_seen_at) / 1000)
      ),
      online: true,
    };
  });
}

export function RealtimeBoard() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { status, snapshot } = useRealtime(slug);

  const clockBucket = useClockBucket();

  /**
   * The page-view feed, normalized. `null` only while the first snapshot is
   * awaited (the skeleton covers that). It no longer decides *who* is online —
   * `snapshot.present` does — so an empty feed beside live visitors is an
   * ordinary state rather than the trigger for inventing rows from aggregates.
   * Ages come from the clock store, never a clock read in render.
   */
  const feed: FeedEvent[] | null = React.useMemo(() => {
    if (snapshot === null) return null;
    const events = snapshot.events ?? [];
    const nowMs = clockBucket * 10_000;
    return events.map((event) => ({
      event_id: event.event_id,
      visitor: event.visitor,
      path: event.path,
      country: event.country ?? "unknown",
      device_type: event.device_type ?? "unknown",
      browser: event.browser,
      os: event.os,
      referrer: event.referrer,
      secondsAgo: Math.max(
        0,
        Math.round((nowMs - Date.parse(event.occurred_at)) / 1000)
      ),
    }));
  }, [snapshot, clockBucket, slug]);

  /**
   * The Earlier list, from `analytics/recent-visitors` over the trailing
   * 24 hours — slug-keyed so a site switch never shows another site's
   * people, refreshed each minute, and held across refreshes so the list
   * never blinks empty. Failures stay quiet: this list is auxiliary, and
   * the next tick retries anyway.
   */
  const [recent, setRecent] = React.useState<{
    slug: string;
    items: readonly RecentVisitor[];
  }>({ slug: "", items: [] });
  React.useEffect(() => {
    if (!LIVE_API) return;
    const controller = new AbortController();
    let cancelled = false;
    const fetchRecent = async () => {
      try {
        const { site_id } = await resolveSiteSlugCached(slug);
        const timezone =
          Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
        const response = await getRecentVisitors(
          site_id,
          { hours: 24, timezone },
          { signal: controller.signal }
        );
        if (!cancelled) setRecent({ slug, items: response.items });
      } catch {
        // Auxiliary read; the interval below is the retry.
      }
    };
    void fetchRecent();
    const timer = setInterval(() => void fetchRecent(), 60_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [slug]);
  const recentItems = React.useMemo(
    () => (recent.slug === slug ? recent.items : []),
    [recent, slug]
  );

  /**
   * The revenue markers, by hash (ADR-0036 CP7): revenue attributed to a
   * visitor **within the trailing window**, riding the recent-visitors read
   * itself — no extra request. A map rather than a row field because live
   * rows come from the feed, which carries no money; the same person's
   * marker still applies to their live row through the shared hash.
   *
   * Owner-only **by absence**: for a non-owner the field never arrives, so
   * this map stays empty and nothing money-shaped renders — which is the
   * contract's own affordance rule, not probing. Never coerce a missing
   * marker into `$0`: for an owner it means "no attributed revenue in this
   * window", for anyone else "not yours to see".
   */
  const revenueByHash = React.useMemo(() => {
    const markers = new Map<string, VisitorRevenue>();
    for (const item of recentItems) {
      if (item.revenue !== undefined) markers.set(item.visitor, item.revenue);
    }
    return markers;
  }, [recentItems]);

  /**
   * Live rows come from the feed; earlier ones from the recent-visitors
   * read, minus anyone currently live — the same person must not appear in
   * both lists at once. The hash is shared between the two sources, so
   * either row opens the same detail view.
   */
  const nowS = clockBucket * 10;
  const visitors = React.useMemo(() => {
    const present =
      snapshot === null || feed === null
        ? []
        : onlineVisitors(snapshot.present ?? [], feed, nowS);
    const presentHashes = new Set(present.map((visitor) => visitor.hash));
    const past: AnonVisitor[] = [];
    for (const item of recentItems) {
      if (presentHashes.has(item.visitor)) continue;
      const lastSeenS = Math.floor(Date.parse(item.last_seen) / 1000);
      past.push({
        hash: item.visitor,
        name: anonName(item.visitor),
        country: item.country === "" ? "unknown" : item.country,
        deviceType: item.device_type === "" ? "unknown" : item.device_type,
        browser: item.browser === "" ? null : item.browser,
        os: item.os === "" ? null : item.os,
        referrer: null,
        currentPath: null,
        events: [],
        pageviews: item.pageviews,
        secondsAgo: Math.max(0, nowS - lastSeenS),
        online: false,
      });
    }
    past.sort((a, b) => a.secondsAgo - b.secondsAgo);
    return [...present, ...past];
  }, [snapshot, feed, recentItems, nowS]);
  const online = visitors.filter((visitor) => visitor.online);
  const earlier = visitors.filter((visitor) => !visitor.online);

  /**
   * Presence is authoritative for *how many* are here, and `present` names as
   * many of them as the snapshot carries (50). The gap between the two is now
   * only reachable on a site with more than 50 people on it at once — it used
   * to open up for a single long reader, because rows could only be built for
   * visitors the page-view feed knew. It still renders as its own line rather
   * than being silently dropped: naming 50 and stating the rest as a count is
   * honest, inventing the 51st is not.
   *
   * Trusted only while the snapshot is fresh — but the reason changed with
   * ADR-0035, so the number did too. The hub now recomputes on a timer while
   * anyone is connected, so a quiet site still produces a snapshot every ~10s
   * and a stale one no longer means "the site went quiet": it means the stream
   * is dead. `REALTIME_SNAPSHOT_MAX_AGE_SECONDS` is that threshold, stated on
   * the contract because only the server knows its own cadence — the old 90s
   * was a hand-tuned guess at "six heartbeats", made when there was no timer to
   * derive anything from.
   */
  const snapshotAgeS =
    snapshot === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, nowS - Math.floor(Date.parse(snapshot.generated_at) / 1000));
  const presenceCount =
    snapshot !== null && snapshotAgeS <= REALTIME_SNAPSHOT_MAX_AGE_SECONDS
      ? snapshot.active_visitors
      : 0;
  const hiddenOnline = Math.max(0, presenceCount - online.length);
  const onlineCount = Math.max(online.length, presenceCount);

  const [activeHash, setActiveHash] = React.useState<string | null>(null);
  // Derived, not stored: a fresh snapshot re-resolves the open modal to the
  // same visitor's new events, and closes it if the hash rotated away.
  const active = visitors.find((visitor) => visitor.hash === activeHash) ?? null;
  const close = React.useCallback(() => setActiveHash(null), []);

  const renderRow = (visitor: AnonVisitor) => {
    const revenue = revenueByHash.get(visitor.hash) ?? null;
    return (
    <button
      key={visitor.hash}
      type="button"
      onClick={() => setActiveHash(visitor.hash)}
      className="relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* online marker — transparent placeholder keeps offline rows aligned */}
      <span
        aria-hidden="true"
        className={
          "size-1.5 shrink-0 rounded-full " +
          (visitor.online ? "bg-primary" : "bg-transparent")
        }
      />
      <UserAvatar seed={visitor.hash} size={24} />
      <span className="min-w-0 shrink-0 text-sm font-medium">
        {visitor.name}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {visitor.events[0]?.path ??
          visitor.currentPath ??
          (visitor.pageviews !== null
            ? `${visitor.pageviews} ${visitor.pageviews === 1 ? "page" : "pages"}`
            : "")}
      </span>
      {/* a marker, not a column: the pill exists only on rows the wire gave
          money to, so nothing shifts for anyone else. A `pageviews: 0` row
          with a pill is the window rule working — their payment is inside
          the window, their browsing is not. */}
      {revenue !== null ? (
        <Badge
          className="shrink-0 tabular-nums"
          icon={<CoinsDollarIcon />}
          size="sm"
          variant="success"
        >
          {formatMoney(revenue.amount_minor, revenue.currency)}
        </Badge>
      ) : null}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
        {timeAgo(visitor.secondsAgo)}
      </span>
      <span className="flex items-center gap-1.5">
        <MarkCircle className="size-6">
          <FlagIcon code={visitor.country} className="size-4" />
        </MarkCircle>
        {visitor.browser !== null && (
          <MarkCircle className="size-6">
            <BrowserIcon family={visitor.browser} className="size-4" />
          </MarkCircle>
        )}
        {/* OS carries the row's third mark; the device glyph only stands in
            when the feed didn't record one */}
        <MarkCircle className="size-6">
          {visitor.os !== null ? (
            <OSIcon family={visitor.os} className="size-4" />
          ) : (
            <DeviceGlyph
              deviceType={visitor.deviceType}
              className="size-4"
            />
          )}
        </MarkCircle>
      </span>
    </button>
    );
  };

  /**
   * The modal's journey from `analytics/visitor` — hash-keyed so an answer
   * for one visitor can never paint another's modal, and refetched every
   * 30 s while open so a fresh pageview surfaces at the top of the current
   * session. Until (or unless) the read answers, the live feed's own pages
   * stand in as a one-card session, so the modal is never blank for a live
   * visitor.
   */
  const trailRefresh = Math.floor(clockBucket / 3);
  /**
   * A fresh feed event for the open visitor refetches the trail *now*, not
   * at the next 30 s tick: the feed cannot say which session a page belongs
   * to, so the overlay below parks it on the current card — and when the
   * page actually opened a new session (a closed tab come back), only the
   * server's answer can split the cards. Fetching on arrival keeps that
   * split from lagging half a minute behind the row.
   */
  const newestLiveEventId =
    activeHash !== null
      ? (visitors.find((visitor) => visitor.hash === activeHash)?.events[0]
          ?.event_id ?? null)
      : null;
  type TrailEntry = {
    sessions: readonly VisitorSession[];
    /** CP7's owner-only additions; `?? null`/`?? []` because they are
     * optional by absence, and absence must render as nothing. */
    revenue: VisitorRevenue | null;
    revenueEvents: readonly RevenueJourneyEntry[];
  };
  /**
   * Answered trails, kept per visitor rather than one slot.
   *
   * With a single slot, every switch to a different visitor started from
   * nothing: `trailLoaded` went false, the skeleton painted, and on a fast
   * api the answer landed ~150 ms later — a blink on every open. The file
   * already refuses to blink on the refresh paths (the 30 s bucket and a
   * fresh live event overwrite the old answer only when the new one lands);
   * this extends the same rule to switching visitors. A visitor opened
   * before shows their last answer instantly and the refetch below revises
   * it silently; the skeleton is left meaning what it says, a visitor this
   * session has never answered for.
   *
   * The loading-versus-empty doctrine is untouched: an answered-and-empty
   * trail is cached as `sessions: []`, which is loaded, not loading.
   * Bounded because a realtime board can be clicked through all evening;
   * past the cap the oldest entry leaves, and a re-answered visitor is
   * re-inserted so recency is what the order tracks.
   */
  const TRAIL_CACHE_LIMIT = 20;
  const [trails, setTrails] = React.useState<ReadonlyMap<string, TrailEntry>>(
    () => new Map()
  );
  React.useEffect(() => {
    // The refresh bucket retires this effect every 30 s while the modal is
    // open, and a new live event retires it immediately; the fetch itself
    // is identical each time.
    void trailRefresh;
    void newestLiveEventId;
    if (!LIVE_API || activeHash === null) return;
    const controller = new AbortController();
    let cancelled = false;
    const fetchTrail = async () => {
      try {
        const { site_id } = await resolveSiteSlugCached(slug);
        const timezone =
          Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
        const response = await getVisitorTrail(
          site_id,
          { hash: activeHash, hours: 24, timezone },
          { signal: controller.signal }
        );
        if (!cancelled) {
          setTrails((previous) => {
            const next = new Map(previous);
            // Delete-then-set so a refreshed visitor moves to the young end;
            // the eviction below trims from the old end.
            next.delete(activeHash);
            next.set(activeHash, {
              sessions: response.sessions,
              revenue: response.revenue ?? null,
              revenueEvents: response.revenue_events ?? [],
            });
            while (next.size > TRAIL_CACHE_LIMIT) {
              const oldest = next.keys().next().value;
              if (oldest === undefined) break;
              next.delete(oldest);
            }
            return next;
          });
        }
      } catch {
        // The live feed's pages keep the modal honest meanwhile.
      }
    };
    void fetchTrail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, activeHash, trailRefresh, newestLiveEventId]);
  const trail = active !== null ? (trails.get(active.hash) ?? null) : null;
  const serverSessions = trail !== null ? trail.sessions : null;
  /**
   * The modal's revenue facts. The trail's own answer wins (same window,
   * same read as the sessions on screen); until it lands, the row marker
   * from recent-visitors stands in so the number does not blink in late.
   * Both absent → nothing money-shaped renders, and that absence is the
   * owner-only rule doing its work, not a loading state.
   */
  const activeRevenue =
    active === null
      ? null
      : ((trail !== null ? trail.revenue : null) ??
        revenueByHash.get(active.hash) ??
        null);
  const activeRevenueEvents = trail !== null ? trail.revenueEvents : [];
  /**
   * "No sessions yet" and "not answered yet" are different facts. Until the
   * trail read resolves for *this* hash, the journey band shows a
   * placeholder, not an empty band a reader would take as "no history".
   * An answered-and-empty trail is real: the server has no pageviews for
   * this hash in the window — a presence-only visitor, a visitor whose
   * address changed mid-visit and so is on their second hash, or (rarely,
   * and only under a backlog) the read lagging the leading edge of ingest.
   */
  const trailLoaded = !LIVE_API || serverSessions !== null;

  let sessionsForModal: VisitorModalSession[] =
    serverSessions !== null && serverSessions.length > 0
      ? visitorTrailToModalSessions(serverSessions, nowS)
      : active !== null && active.events.length > 0
        ? [
            {
              id: "current",
              startedAtS: nowS - active.secondsAgo,
              referrer: active.referrer,
              entries: active.events.map((event) => ({
                id: event.event_id,
                path: event.path,
                secondsAgo: event.secondsAgo,
              })),
            },
          ]
        : [];
  /**
   * The list's newest page arrives off the live feed within a second or two;
   * the visitor read trails it slightly at the leading edge of ingest.
   * Overlay the feed's not-yet-listed events onto the current session card so
   * the modal keeps pace with the row — the two sources share `event_id`, so
   * the overlay can never duplicate a page the read already carries, and the
   * next 30 s refetch folds the same pages into the server's own ordering.
   */
  if (
    active !== null &&
    active.online &&
    serverSessions !== null &&
    sessionsForModal.length > 0
  ) {
    const known = new Set(
      sessionsForModal.flatMap((session) =>
        session.entries.map((entry) => entry.id)
      )
    );
    const fresh = active.events
      .filter((event) => !known.has(event.event_id))
      .map((event) => ({
        id: event.event_id,
        path: event.path,
        secondsAgo: event.secondsAgo,
      }));
    if (fresh.length > 0) {
      const [current, ...rest] = sessionsForModal;
      sessionsForModal = [
        { ...current, entries: [...fresh, ...current.entries] },
        ...rest,
      ];
    }
  }

  const oldestSession = sessionsForModal[sessionsForModal.length - 1];

  /**
   * First seen prefers the api's own `first_seen` — the true minimum over
   * the window — over the oldest *fetched* session, which is bounded by the
   * trail's row cap and, before the trail answers, doesn't exist at all.
   * Whichever sources answered, the earliest wins; the row's own age is the
   * last resort so the field is never blank.
   */
  const recentRow =
    active !== null
      ? (recentItems.find((item) => item.visitor === active.hash) ?? null)
      : null;
  const firstSeenAgoS = (() => {
    if (active === null) return 0;
    const candidatesS: number[] = [];
    if (recentRow !== null) {
      candidatesS.push(Math.floor(Date.parse(recentRow.first_seen) / 1000));
    }
    if (oldestSession !== undefined) candidatesS.push(oldestSession.startedAtS);
    if (candidatesS.length === 0) return active.secondsAgo;
    return Math.max(0, nowS - Math.min(...candidatesS));
  })();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-2">
      <RealtimeConnectionBanner className="mb-0" status={status} />

      {snapshot === null && status === "access_lost" ? null : (
        <SkeletonReveal
          ready={snapshot !== null}
          skeleton={
            // Pixel-matched to a visitor row: the section label, then rows
            // with the online dot slot, avatar, name, path, age and the
            // three mark circles — same paddings, same 24px row core.
            <div className="mx-auto w-full max-w-2xl pb-8">
              <div className="px-2.5 pb-1 pt-0.5">
                <SkeletonBar className="h-4 w-14" />
              </div>
              {[0, 1, 2].map((index) => (
                <div
                  className="flex items-center gap-2.5 px-2.5 py-2"
                  key={index}
                >
                  <span className="size-1.5 shrink-0" />
                  <SkeletonCircle className="size-6" />
                  <SkeletonBar className="h-3.5 w-24 shrink-0" />
                  {/* the path column tapers like real paths do */}
                  <SkeletonBar
                    className={
                      "h-3 flex-1 " +
                      ["max-w-44", "max-w-32", "max-w-24"][index]
                    }
                  />
                  <span className="flex-1" />
                  <SkeletonBar className="h-3 w-10 shrink-0" />
                  <span className="flex items-center gap-1.5">
                    <SkeletonCircle className="size-4" />
                    <SkeletonCircle className="size-4.5" />
                    <SkeletonCircle className="size-4.5" />
                  </span>
                </div>
              ))}
            </div>
          }
        >
          {snapshot !== null ? (
            snapshot.active_visitors === 0 && visitors.length === 0 ? (
              <p className="pb-8 text-center text-sm leading-6 text-muted-foreground">
                Open the site in another tab and browse around. A visit shows
                up here within seconds.
              </p>
            ) : (
              <div className="mx-auto w-full max-w-2xl pb-8">
                {online.length > 0 || hiddenOnline > 0 ? (
                  <p className="px-2.5 pb-1 text-sm font-medium tracking-wide text-muted-foreground/70">
                    Online · {onlineCount}
                  </p>
                ) : null}
                {online.map(renderRow)}
                {hiddenOnline > 0 ? (
                  // More people are here than the snapshot names individually
                  // (its `present` list is bounded at 50). No row can be drawn
                  // without inventing an identity, so the count is stated.
                  <p className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="bp-pulse size-1.5 shrink-0 rounded-full bg-primary"
                    />
                    +{hiddenOnline} more online
                  </p>
                ) : null}
                {earlier.length > 0 ? (
                  <p className="px-2.5 pb-1 pt-4 text-sm font-medium tracking-wide text-muted-foreground/70">
                    Earlier · last 24 hours
                  </p>
                ) : null}
                {earlier.map(renderRow)}
              </div>
            )
          ) : null}
        </SkeletonReveal>
      )}

      {/* hero-identity modal — plain entrance, X top-right, Escape closes */}
      <AnimatePresence>
        {active && (
          <VisitorDetailModal
            firstSeenAgoS={firstSeenAgoS}
            onClose={close}
            revenue={activeRevenue}
            revenueEvents={activeRevenueEvents}
            sessions={sessionsForModal}
            trailLoaded={trailLoaded}
            visitor={active}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Self-contained visitor detail modal for any `RecentVisitor` row outside the
 * `/realtime` board (e.g. the Revenue card's Paying visitors list). Fetches
 * `analytics/visitor?hash=` over the trailing 24 hours so the caller gets the
 * exact same hero-identity card, revenue entries, and session-by-session
 * referrer + page trail as `/realtime`.
 */
export function RecentVisitorModal({
  slug,
  visitor,
  onClose,
  onBack,
}: {
  slug: string;
  visitor: RecentVisitor;
  onClose: () => void;
  onBack?: () => void;
}) {
  const clockBucket = useClockBucket();
  const nowS = clockBucket * 10;
  const trailRefresh = Math.floor(clockBucket / 3);
  const [trail, setTrail] = React.useState<{
    hash: string;
    sessions: readonly VisitorSession[];
    revenue: VisitorRevenue | null;
    revenueEvents: readonly RevenueJourneyEntry[];
  } | null>(null);

  React.useEffect(() => {
    void trailRefresh;
    if (!LIVE_API) return;
    const controller = new AbortController();
    let cancelled = false;
    const fetchTrail = async () => {
      try {
        const { site_id } = await resolveSiteSlugCached(slug);
        const timezone =
          Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
        const response = await getVisitorTrail(
          site_id,
          { hash: visitor.visitor, hours: 24, timezone },
          { signal: controller.signal }
        );
        if (!cancelled) {
          setTrail({
            hash: visitor.visitor,
            sessions: response.sessions,
            revenue: response.revenue ?? null,
            revenueEvents: response.revenue_events ?? [],
          });
        }
      } catch {
        // Keep previous or empty state if the auxiliary read fails.
      }
    };
    void fetchTrail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, visitor.visitor, trailRefresh]);

  const target = React.useMemo(
    () => recentVisitorToModalTarget(visitor, nowS),
    [visitor, nowS]
  );
  const currentTrail = trail !== null && trail.hash === visitor.visitor ? trail : null;
  const trailLoaded = !LIVE_API || currentTrail !== null;
  const sessions =
    currentTrail !== null
      ? visitorTrailToModalSessions(currentTrail.sessions, nowS)
      : [];
  const oldestSession = sessions[sessions.length - 1];
  const firstSeenAgoS = (() => {
    const candidatesS: number[] = [
      Math.floor(Date.parse(visitor.first_seen) / 1000),
    ];
    if (oldestSession !== undefined) candidatesS.push(oldestSession.startedAtS);
    return Math.max(0, nowS - Math.min(...candidatesS));
  })();
  const revenue =
    (currentTrail !== null ? currentTrail.revenue : null) ??
    visitor.revenue ??
    null;
  const revenueEvents = currentTrail !== null ? currentTrail.revenueEvents : [];

  return (
    <VisitorDetailModal
      firstSeenAgoS={firstSeenAgoS}
      onBack={onBack}
      onClose={onClose}
      revenue={revenue}
      revenueEvents={revenueEvents}
      sessions={sessions}
      trailLoaded={trailLoaded}
      visitor={target}
    />
  );
}

function VisitorDetailModal({
  visitor,
  firstSeenAgoS,
  revenue,
  revenueEvents,
  sessions,
  trailLoaded,
  onClose,
  onBack,
}: {
  visitor: VisitorModalTarget;
  firstSeenAgoS: number;
  revenue: VisitorRevenue | null;
  revenueEvents: readonly RevenueJourneyEntry[];
  sessions: readonly VisitorModalSession[];
  trailLoaded: boolean;
  onClose: () => void;
  onBack?: () => void;
}) {
  const names = React.useMemo(
    () => new Intl.DisplayNames(["en"], { type: "region" }),
    []
  );
  const countryName = (code: string): string => {
    if (code === "unknown" || code === "") return "Unknown";
    try {
      return names.of(code.toUpperCase()) ?? code;
    } catch {
      return code;
    }
  };

  // Scroll hint (same language as the overview mini cards): a chevron chip at
  // the modal's bottom while there is more below; it fades once you reach it.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [scrollHint, setScrollHint] = React.useState<"none" | "more" | "end">(
    "none"
  );
  const measureScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.clientHeight <= 4) {
      setScrollHint("none");
      return;
    }
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    setScrollHint(atEnd ? "end" : "more");
  }, []);

  // ResizeObserver fires its initial callback async, so no setState-in-effect
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureScroll);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [visitor.hash, measureScroll]);

  // Escape steps back when opened from a parent list, or closes the modal.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") (onBack ?? onClose)();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack, onClose]);

  // The hero says who with marks, not words: flag, browser, OS and device as
  // icons under the name (each carries its label for hover and screen
  // readers), with the time facts spelled out below.
  //
  // **Where they are is the third fact, and the board already knew it.** The
  // row renders the presence `path`; the modal had the same visitor object in
  // scope and printed only the two times. That is how this panel could say it
  // had no pageviews for somebody standing on a page: the trail is keyed on an
  // anonymous id, presence is not, and the modal was showing only the half
  // that can be empty.
  const details: Array<{
    label: string;
    value: React.ReactNode;
    /** Full width on its own row: a path is longer than half a grid column. */
    wide?: boolean;
  }> = [
    { label: "First seen", value: timeAgo(firstSeenAgoS) },
    {
      label: "Last seen",
      value: visitor.online ? (
        <span
          key="online"
          className="flex items-center justify-center gap-1.5 text-success-foreground"
        >
          <span className="bp-pulse size-1.5 rounded-full bg-success" />
          Now
        </span>
      ) : (
        timeAgo(visitor.secondsAgo)
      ),
    },
    // Presence only. Rows built from the recent-visitors read carry
    // `currentPath: null`, and for those the trail below is the answer
    // rather than a path they left some time ago.
    ...(visitor.currentPath === null
      ? []
      : [
          {
            label: "Currently on",
            value: (
              <span className="block truncate" title={visitor.currentPath}>
                {visitor.currentPath}
              </span>
            ),
            wide: true,
          },
        ]),
  ];

  // z-[60]: above the floating tab bar (z-50)
  return (
    <div className="fixed inset-0 z-[60]">
      <motion.div
        key="visitor-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      {/* flex centering wrapper — motion keeps full control of the
          panel's transform, so no translate classes on the panel */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <motion.div
          key="visitor-panel"
          role="dialog"
          aria-modal="true"
          aria-label={visitor.name}
          // Bouncy pop: the centered card springs in with a slight
          // bounce. The drop shadow lives here — the squircle clip
          // inside would slice it off.
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: 0.94,
            transition: { duration: 0.12 },
          }}
          transition={POP_SPRING}
          className="pointer-events-auto relative h-[min(85vh,760px)] w-full max-w-lg rounded-[36px] shadow-[0_24px_80px_rgba(0,0,0,0.3)] sm:rounded-[48px]"
        >
          {/* the card itself, in the squircle language — no gray frame */}
          <SquircleSurface className="relative h-full w-full overflow-hidden rounded-[36px] border border-border bg-card [--card-clip-radius:20px] sm:rounded-[58px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:26px]">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back"
                className="absolute left-4 top-4 z-20 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/4 text-muted-foreground outline-none transition-colors hover:bg-black/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeft01Icon className="size-4" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 z-20 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/4 text-muted-foreground outline-none transition-colors hover:bg-black/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Cancel01Icon className="size-4" />
            </button>

            {/* min-h-full column so the gray journey band always
                stretches to the bottom; no visible scrollbar, and
                overscroll-none kills the rubber-band that flashes a
                different background */}
            <motion.div
              ref={scrollRef}
              onScroll={measureScroll}
              variants={MODAL_CONTAINER}
              initial="hidden"
              animate="show"
              className="h-full overflow-y-auto overscroll-none bg-[#f6f6f6] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div className="flex min-h-full flex-col">
                {/* hero identity — flips up into place with the
                    choreography */}
                <motion.div
                  variants={MODAL_ITEM}
                  className="flex flex-col items-center gap-5 bg-card px-6 pb-8 pt-14 text-center"
                >
                  <UserAvatar seed={visitor.hash} size={64} />
                  <p className="text-xl font-medium tracking-tight">
                    {visitor.name}
                  </p>

                  {/* tech marks — icon-only, the tab bar's gliding
                      tooltip carries the labels */}
                  <TechMarks
                    items={[
                      {
                        key: "country",
                        label: countryName(visitor.country),
                        icon: (
                          <FlagIcon
                            code={visitor.country}
                            className="size-4.5"
                          />
                        ),
                      },
                      ...(visitor.browser !== null
                        ? [
                            {
                              key: "browser",
                              label: familyLabel(visitor.browser),
                              icon: (
                                <BrowserIcon
                                  family={visitor.browser}
                                  className="size-5"
                                />
                              ),
                            },
                          ]
                        : []),
                      ...(visitor.os !== null
                        ? [
                            {
                              key: "os",
                              label: familyLabel(visitor.os),
                              icon: (
                                <OSIcon
                                  family={visitor.os}
                                  className="size-5"
                                />
                              ),
                            },
                          ]
                        : []),
                      {
                        key: "device",
                        label:
                          DEVICE_LABEL[visitor.deviceType] ??
                          visitor.deviceType,
                        icon: (
                          <DeviceGlyph
                            deviceType={visitor.deviceType}
                            className="size-5"
                          />
                        ),
                      },
                    ]}
                  />

                  {/* the window's money, said in one pill (CP7). It
                      appears only when the wire sent it — owner with
                      attributed revenue — so nobody else's modal ever
                      grows a money-shaped hole. */}
                  {revenue !== null ? (
                    <p className="flex items-center gap-1 rounded-full bg-success/15 px-3 py-1 text-sm font-medium tabular-nums text-success-foreground">
                      {formatMoney(revenue.amount_minor, revenue.currency)}
                      <span className="font-normal opacity-80">
                        ·{" "}
                        {revenue.transaction_count === 1
                          ? "1 charge"
                          : `${revenue.transaction_count} charges`}
                      </span>
                    </p>
                  ) : null}

                  <div className="grid grid-cols-2 gap-x-10 gap-y-5">
                    {details.map((detail) => (
                      <div
                        className={
                          detail.wide ? "col-span-2 min-w-0" : undefined
                        }
                        key={detail.label}
                      >
                        <p className="text-xs text-muted-foreground">
                          {detail.label}
                        </p>
                        <div className="mt-1 text-sm font-medium">
                          {detail.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>

                {/* the trail below, on gray — flex-1 keeps the band
                    solid to the panel's bottom even when short; z-10 so
                    it rides over the receding hero */}
                <div className="relative z-10 flex-1 border-t border-border bg-[#f6f6f6]">
                  <div className="mx-auto flex w-full max-w-md flex-col gap-3 px-6 py-8">
                    {/* The money entries, as their own card — never
                        interleaved into a session: which session a
                        payment happened *inside* is not measured
                        anywhere (last-touch is an approximation), so
                        placing a charge between two pageviews would be
                        rendering a claim the data does not make. Each
                        line is the journey view's own renderer, wire
                        sentence and all. */}
                    {revenueEvents.length > 0 ? (
                      <motion.div variants={MODAL_ITEM}>
                        <SquircleSurface className="flex flex-col rounded-[24px] border border-border bg-card p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[36px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]">
                          <p className="flex items-center justify-between gap-2 pb-1.5 pl-3.5 pr-3 pt-1 text-sm text-muted-foreground">
                            <span>Revenue · last 24 hours</span>
                          </p>
                          <SquircleSurface className="flex-1 overflow-hidden rounded-[20px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
                            <ol className="flex flex-col gap-2 px-4 py-3">
                              {revenueEvents.map((entry) => (
                                <JourneyEntryRow
                                  entry={entry}
                                  key={`${entry.event_id}-${entry.occurred_at}`}
                                />
                              ))}
                            </ol>
                          </SquircleSurface>
                        </SquircleSurface>
                      </motion.div>
                    ) : null}
                    {sessions.length === 0 ? (
                      trailLoaded ? (
                        // Answered and empty — a real fact, stated: the
                        // server has no pageviews for this hash in the
                        // window.
                        <motion.p
                          variants={MODAL_ITEM}
                          className="px-2 py-4 text-center text-sm leading-6 text-muted-foreground"
                        >
                          {visitor.currentPath !== null ? (
                            <>
                              On{" "}
                              <span className="font-medium text-foreground">
                                {visitor.currentPath}
                              </span>{" "}
                              right now.{" "}
                            </>
                          ) : null}
                          No pageviews recorded for this visitor in the last 24
                          hours. Presence is refreshed by any activity, so
                          somebody can be here without one.
                        </motion.p>
                      ) : null
                    ) : null}
                    {sessions.map((session, index) => (
                      <motion.div
                        key={index === 0 ? "current-session" : session.id}
                        variants={MODAL_ITEM}
                      >
                        {/* overview-card anatomy: squircle frame, meta
                            in the top strip, pageviews on the inset
                            panel; newest page sits on top */}
                        <SquircleSurface className="flex flex-col rounded-[24px] border border-border bg-card p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[36px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]">
                          <p className="flex items-center justify-between gap-2 pb-1.5 pl-3.5 pr-3 pt-1 text-sm text-muted-foreground">
                            <span>
                              {index === 0 && visitor.online
                                ? "This session"
                                : "Earlier"}{" "}
                              · {clockLabel(session.startedAtS)}
                            </span>
                            {/* null referrer IS Direct — the server
                                already drops self-referrals (ADR-0028),
                                so no external source means exactly what
                                the reports' Direct bucket means */}
                            <ReferrerInline entry={session.referrer} />
                          </p>
                          <SquircleSurface className="flex-1 overflow-hidden rounded-[20px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
                            <div className="py-1.5">
                              {session.entries.map((entry) => (
                                <div
                                  key={entry.id}
                                  className="flex items-center justify-between gap-3 px-4 py-1.5 text-sm"
                                >
                                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                    {entry.path}
                                  </span>
                                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                    {timeAgo(entry.secondsAgo)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </SquircleSurface>
                        </SquircleSurface>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>

            {/* scroll hint — same chip as the overview mini cards: bobs
                while there is more below, fades away at the end */}
            <AnimatePresence>
              {scrollHint === "more" && (
                <motion.span
                  aria-hidden="true"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex size-6 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-white/90 shadow-sm"
                >
                  <motion.span
                    animate={{ y: [0, 2.5, 0] }}
                    transition={{
                      duration: 1.4,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                    className="flex"
                  >
                    <ArrowDown01Icon className="size-3.5 text-muted-foreground" />
                  </motion.span>
                </motion.span>
              )}
            </AnimatePresence>
          </SquircleSurface>
        </motion.div>
      </div>
    </div>
  );
}

