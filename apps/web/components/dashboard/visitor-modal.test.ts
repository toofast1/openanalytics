import { describe, expect, it } from "vitest"
import {
  recentVisitorToModalTarget,
  visitorTrailToModalSessions,
} from "./realtime-board"
import type { RecentVisitor, VisitorSession } from "@/lib/api"

describe("paying visitor modal -> visitor trail modal mapping", () => {
  it("converts a RecentVisitor row from Paying visitors into a VisitorModalTarget", () => {
    const row: RecentVisitor = {
      visitor: "v_payer_1",
      country: "US",
      device_type: "desktop",
      browser: "chrome",
      os: "macos",
      first_seen: "2026-10-28T15:29:00.000Z",
      last_seen: "2026-10-28T15:38:00.000Z",
      pageviews: 6,
      revenue: { amount_minor: 1900, currency: "USD", transaction_count: 1 },
    }
    const nowS = Math.floor(Date.parse("2026-10-28T16:00:00.000Z") / 1000)
    const target = recentVisitorToModalTarget(row, nowS)

    expect(target.hash).toBe("v_payer_1")
    expect(target.country).toBe("US")
    expect(target.deviceType).toBe("desktop")
    expect(target.browser).toBe("chrome")
    expect(target.os).toBe("macos")
    expect(target.online).toBe(false)
    expect(target.secondsAgo).toBe(22 * 60)
  })

  it("maps visitor trail sessions newest-page-first and extracts the session referrer", () => {
    const nowS = Math.floor(Date.parse("2026-10-28T16:00:00.000Z") / 1000)
    const sessions: VisitorSession[] = [
      {
        session_id: "s1",
        started_at: "2026-10-28T15:29:00.000Z",
        ended_at: "2026-10-28T15:37:00.000Z",
        pages: [
          {
            event_id: "e1",
            occurred_at: "2026-10-28T15:29:00.000Z",
            page_path: "/",
            page_title: "Home",
            referrer_domain: "indiehackers.com",
          },
          {
            event_id: "e2",
            occurred_at: "2026-10-28T15:37:00.000Z",
            page_path: "/submit",
            page_title: "Submit",
            referrer_domain: "",
          },
        ],
      },
    ]

    const mapped = visitorTrailToModalSessions(sessions, nowS)
    expect(mapped).toEqual([
      {
        id: "s1",
        startedAtS: Math.floor(Date.parse("2026-10-28T15:29:00.000Z") / 1000),
        referrer: "indiehackers.com",
        entries: [
          { id: "e2", path: "/submit", secondsAgo: 23 * 60 },
          { id: "e1", path: "/", secondsAgo: 31 * 60 },
        ],
      },
    ])
  })
})

