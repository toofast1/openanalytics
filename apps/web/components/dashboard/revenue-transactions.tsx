"use client";

import { Cancel01Icon } from "hugeicons-react";
import * as React from "react";
import { CircleDashedIcon } from "@/components/icons/hugeicons";
import { Badge } from "@/components/ui/badge";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { Button } from "@/components/ui/button";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  ApiError,
  presentError,
  revenue,
  type AnalyticsRange,
  type RevenueJourneyEntry,
  type RevenueJourneyResponse,
  type RevenueTouch,
  type RevenueTransaction,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { cn } from "@/lib/utils";

/**
 * The transaction list, and one purchase's journey (frontend_tasks §25).
 *
 * **This is the app's first cursor-paginated list**, and the cursor is opaque:
 * it is passed back exactly as received, never parsed and never constructed. A
 * malformed one answers `400 VALIDATION_FAILED` naming `cursor` rather than
 * silently restarting at page one — so that code drops the cursor and restarts
 * *deliberately*, with the list visibly reset. A silent restart is how a paging
 * client loops forever over the same first page.
 *
 * **Each kind puts its money in a different field**, and the row renders the
 * field that belongs to its kind: a charge's amount is `gross`, a refund's is
 * `refund`, and a dispute's is in `net` alone — `gross` and `refund` are both
 * zero on it, because a dispute is neither. `net` is a magnitude; the sign
 * belongs to the kind. Adding a page up will not reproduce the summary, and
 * nothing here tries to.
 *
 * **Amounts are in each transaction's own original currency**, not the site's,
 * which is why every figure is formatted from its own `Money.currency` rather
 * than from one shared symbol.
 */

/* ------------------------------------------------------------------ */
/* Row vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * Provider status words we have copy for. The dispute list is deliberately
 * open — `warning_needs_response`, `warning_under_review` and whatever Stripe
 * adds next — so an unmapped key falls through to itself rather than being
 * collapsed. Rendering "still arguing" as "lost" destroys the distinction a
 * dispute row exists for.
 */
const STATUS_COPY: Record<string, string> = {
  succeeded: "Succeeded",
  pending: "Pending",
  failed: "Failed",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
  canceled: "Canceled",
  needs_response: "Needs response",
  under_review: "Under review",
  won: "Won",
  lost: "Lost",
};

function statusLabel(status: string): string {
  return STATUS_COPY[status] ?? status.replaceAll("_", " ");
}

const KIND_COPY: Record<RevenueTransaction["object_kind"], string> = {
  charge: "Charge",
  refund: "Refund",
  dispute: "Dispute",
};

/**
 * The money a row is *about*, from the field its kind uses.
 *
 * Reading `net` for everything would be wrong on a charge that was later
 * refunded — its `net` is the movement, its `gross` is what the customer
 * actually paid — and reading `gross` for everything would render every
 * dispute and refund as zero.
 */
function rowMoney(row: RevenueTransaction) {
  if (row.object_kind === "charge") return row.gross;
  if (row.object_kind === "refund") return row.refund;
  return row.net;
}

/** A touch's source, in the sources report's own convention. */
function touchSource(touch: RevenueTouch): string {
  if (touch.utm_campaign !== "") return touch.utm_campaign;
  if (touch.utm_source !== "") return touch.utm_source;
  // An empty referrer domain is Direct — the same sentinel the sources report
  // uses, and the reason ADR-0028 strips self-referrals server-side.
  return touch.referrer_domain === "" ? "Direct" : touch.referrer_domain;
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

type Page = {
  items: RevenueTransaction[];
  cursor: string | null;
  hasMore: boolean;
};

export function RevenueTransactions({ siteId }: { siteId: string }) {
  const { range, rangePending } = useAnalyticsInterval();
  const [page, setPage] = React.useState<Page>({
    cursor: null,
    hasMore: false,
    items: [],
  });
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [error, setError] = React.useState<ReturnType<
    typeof presentError
  > | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [active, setActive] = React.useState<RevenueTransaction | null>(null);
  /**
   * Bumped to start the list over. A rejected cursor restarts through this
   * rather than by calling the loader again from inside itself: a paging
   * client that re-enters its own fetch on an error is one bad response away
   * from a loop, and the counter makes the restart a single, visible event.
   */
  const [generation, setGeneration] = React.useState(0);

  /**
   * One loader for both the first page and every "load more". `cursor: null`
   * means "start over", which is also what a rejected cursor falls back to —
   * the list is cleared first so a reader sees the restart happen.
   */
  const load = React.useCallback(
    async (cursor: string | null) => {
      setBusy(true);
      try {
        const response = await revenue.transactions(siteId, range, {
          ...(cursor ? { cursor } : {}),
        });
        setPage((current) => ({
          cursor: response.next_cursor,
          // `has_more` is exact: the server over-fetches by one row rather
          // than counting, so the button binds to it directly.
          hasMore: response.has_more,
          items: cursor
            ? [...current.items, ...response.items]
            : response.items,
        }));
        setStatus("ready");
        setError(null);
      } catch (raised) {
        // A cursor the server will not accept is the one error worth handling
        // rather than showing: drop it and restart from the top, visibly.
        const badCursor =
          raised instanceof ApiError &&
          raised.code === "VALIDATION_FAILED" &&
          cursor !== null;
        if (badCursor) {
          setBusy(false);
          setGeneration((current) => current + 1);
          return;
        }
        setError(presentError(raised));
        setStatus("error");
      }
      setBusy(false);
    },
    [siteId, range]
  );

  /**
   * The range is part of the query, so changing it is a new list rather than a
   * filter over the one already fetched.
   *
   * The work is deferred a tick because the reset is three setState calls and
   * an effect body may not make them synchronously — the hop is what keeps
   * this from cascading a render before the fetch has even started.
   */
  React.useEffect(() => {
    // All-time's anchor is still on its way — the list is already in its
    // loading state; fetching the placeholder range would run it twice.
    if (rangePending) return;
    const timer = setTimeout(() => {
      setStatus("loading");
      setPage({ cursor: null, hasMore: false, items: [] });
      void load(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [load, generation, rangePending]);

  if (status === "error" && error) {
    return (
      <ApiErrorPanel error={error} onRetry={() => void load(null)} />
    );
  }

  if (status === "ready" && page.items.length === 0) {
    return (
      <p className="px-1 py-8 text-center text-sm text-muted-foreground">
        No transactions in this range.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {page.items.map((row) => (
          <TransactionRow
            key={`${row.object_id}-${row.object_kind}`}
            onOpen={() => setActive(row)}
            row={row}
          />
        ))}
      </ul>

      {page.hasMore ? (
        <Button
          className="self-center"
          disabled={busy}
          onClick={() => void load(page.cursor)}
          size="sm"
          variant="secondary"
        >
          {busy ? "Loading…" : "Load more"}
        </Button>
      ) : null}

      {active ? (
        <JourneyDialog
          onClose={() => setActive(null)}
          range={range}
          siteId={siteId}
          transaction={active}
        />
      ) : null}
    </div>
  );
}

function TransactionRow({
  row,
  onOpen,
}: {
  row: RevenueTransaction;
  onOpen: () => void;
}) {
  const money = rowMoney(row);
  // `confidence: 'none'` is a normal row, not an error — it counts in every
  // total. It simply has no journey to open, because no exact signal tied the
  // payment to a visit and no IP or time-proximity guess exists by policy.
  const hasJourney = row.confidence !== "none";

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums">
            {formatMoney(money.amount_minor, money.currency)}
          </span>
          <span className="text-xs text-muted-foreground">
            {KIND_COPY[row.object_kind]} · {statusLabel(row.status)}
          </span>
          {/* A provider test-mode object must never read as real money. */}
          {!row.livemode ? (
            <Badge size="sm" variant="warning">
              Test mode
            </Badge>
          ) : null}
          {/* `reporting` and `conversion` are null together when no usable
              rate existed. Null, not zero — these are exactly the rows behind
              the summary's unconverted remainder, so they are badged rather
              than left blank or shown as 0. */}
          {row.reporting === null ? (
            <Badge icon={<CircleDashedIcon />} size="sm" variant="secondary">
              Not converted
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {row.product_name ?? row.object_id}
          {" · "}
          {new Date(row.occurred_at).toLocaleString()}
        </span>
      </span>

      {hasJourney ? (
        <Button onClick={onOpen} size="xs" variant="secondary">
          Journey
        </Button>
      ) : (
        <span className="text-[11px] text-muted-foreground/70">
          No visit matched
        </span>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* The journey                                                         */
/* ------------------------------------------------------------------ */

const SCOPE_COPY: Record<string, string> = {
  // Worded precisely: the cookieless id rotates daily, so this journey is that
  // day's activity — calling it "their 30-day journey" would promise tracking
  // the product deliberately does not do.
  anonymous_day: "This visitor's activity that day",
  identified: "From the last id rotation before they identified, onward",
};

export function JourneyDialog({
  transaction,
  siteId,
  range,
  onClose,
}: {
  transaction: RevenueTransaction;
  siteId: string;
  range: AnalyticsRange;
  onClose: () => void;
}) {
  const [data, setData] = React.useState<RevenueJourneyResponse | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    // The range is load-bearing rather than decorative: it bounds which
    // partitions are read, so the journey is asked for with exactly the range
    // the list was showing. A charge from outside it answers 404.
    revenue
      .journey(siteId, transaction.object_id, range)
      .then(
        (response) => {
          if (!cancelled) setData(response);
        },
        () => {
          if (!cancelled) setFailed(true);
        }
      );
    return () => {
      cancelled = true;
    };
  }, [siteId, transaction.object_id, range]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const money = rowMoney(transaction);

  return (
    <div className="fixed inset-0 z-[60]">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        role="presentation"
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <SquircleSurface
          aria-label="Purchase journey"
          aria-modal="true"
          className="pointer-events-auto flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-[28px] border border-border bg-card"
          render={<div role="dialog" />}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <p className="text-base font-medium tabular-nums tracking-tight">
                {formatMoney(money.amount_minor, money.currency)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {KIND_COPY[transaction.object_kind]} ·{" "}
                {new Date(transaction.occurred_at).toLocaleString()}
              </p>
            </div>
            <button
              aria-label="Close"
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-black/4 text-muted-foreground transition-colors hover:bg-black/8"
              onClick={onClose}
              type="button"
            >
              <Cancel01Icon className="size-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {failed ? (
              <p className="text-sm text-muted-foreground">
                That journey could not be loaded for this range.
              </p>
            ) : data === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <JourneyBody data={data} />
            )}
          </div>
        </SquircleSurface>
      </div>
    </div>
  );
}

function JourneyBody({ data }: { data: RevenueJourneyResponse }) {
  // An unmatched transaction is a 200, not a 404: "we could not tie this
  // payment to a visit" is a real screen, and a 404 would mean no such
  // transaction on this site at all.
  if (data.matched_via === "none" || data.touchpoint_count === 0) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        No visit is tied to this payment. Matching uses exact signals only (a
        conversion event, a checkout reference, or an identified customer) and
        never guesses from an address or a timestamp. The payment still
        counts in every total.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-xl bg-[#f6f6f6] p-3 text-xs">
        {data.identity_scope ? (
          <p className="text-muted-foreground">
            {SCOPE_COPY[data.identity_scope] ?? data.identity_scope}
          </p>
        ) : null}
        {data.first_touch ? (
          <p>
            <span className="text-muted-foreground">First touch · </span>
            {touchSource(data.first_touch)}
            {data.first_touch.entry_page !== ""
              ? ` → ${data.first_touch.entry_page}`
              : ""}
          </p>
        ) : null}
        {data.last_touch ? (
          <p>
            <span className="text-muted-foreground">Last touch · </span>
            {touchSource(data.last_touch)}
          </p>
        ) : null}
      </div>

      {/* Not a data-quality warning: first touch is computed *before* the cap,
          so a truncated journey costs the model nothing. It is a statement
          about how many rows are on screen. */}
      {data.journey_truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the last {data.entries.length} of {data.touchpoint_count}{" "}
          touchpoints.
        </p>
      ) : null}

      <ol className="flex flex-col gap-2.5">
        {data.entries.map((entry) => (
          <JourneyEntryRow
            entry={entry}
            key={`${entry.event_id}-${entry.occurred_at}`}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * One `RevenueJourneyEntry`, exactly as the wire composed it. Exported
 * because the realtime visitor modal renders the trail's `revenue_events`
 * (ADR-0036 CP7) and the contract says to reuse this renderer rather than
 * invent a second money sentence.
 */
export function JourneyEntryRow({ entry }: { entry: RevenueJourneyEntry }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          entry.display.kind === "session_entry"
            ? "bg-foreground/25"
            : "bg-primary"
        )}
      />
      <span className="min-w-0 flex-1">
        {/* Rendered from `display.text` verbatim — a server-composed
            sentence from a closed template. Inventing one from
            `entry.name` is the exact mistake this shape exists to
            prevent, and an unknown `kind` still has a `text`. */}
        <span className="block text-sm leading-6">
          {entry.display.text}
          {/* `text` never carries an amount: money crosses the wire as
              minor units plus a currency and is formatted here. */}
          <EntryAmount properties={entry.properties} />
        </span>
        <span className="block text-xs text-muted-foreground">
          {new Date(entry.occurred_at).toLocaleString()}
        </span>
      </span>
    </li>
  );
}

/** The money an entry was rendered from, when it carried any. */
function EntryAmount({
  properties,
}: {
  properties: Record<string, unknown>;
}) {
  const minor = properties["amount_minor"];
  const currency = properties["currency"];
  if (typeof minor !== "number" || typeof currency !== "string") return null;
  return (
    <span className="font-medium tabular-nums">
      {" "}
      {formatMoney(minor, currency)}
    </span>
  );
}
