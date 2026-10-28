import { canonicalReferrerHost } from './referrer.ts'
import { PII_REDACTED, type SanitizedUrl } from './event-sanitize.ts'

/**
 * The acquisition source a `?ref=` tag on the landing URL names (ADR-0077).
 *
 * ## The problem this solves
 *
 * `?ref=producthunt` is the convention the directory-and-newsletter ecosystem
 * settled on: Product Hunt appends it to every outbound link, and so do the
 * dozens of smaller launch boards, self-hosting newsletters and design galleries
 * that send a young product its first traffic. The tag survives to us — `ref` is
 * in `ATTRIBUTION_QUERY_KEYS`, so the redactor keeps it — and until this module
 * existed **nothing read it**, so those visits were stored with
 * `referrer_domain = ''` and reported as Direct.
 *
 * Measured on production over 30 days: **11,787 events carried a `ref`, and
 * 11,035 of them (93.6%) had neither a referrer nor a `utm_source`** — every one
 * of them Direct. The tag was the only surviving evidence of where they came
 * from, and it was sitting in a column we already store.
 *
 * ## Why a label may become a host, and why that is not a guess
 *
 * `referrer_domain` is a **grouping key** (ADR-0028): one source must have one
 * spelling or one acquisition channel becomes two rollup rows that no reader can
 * merge back, and the rollups are additive and never rewritten. A `ref` value is
 * not a host — it is whatever the linking site chose to write — so it has to be
 * resolved to the spelling the rest of the pipeline uses.
 *
 * Production answered how, because the two populations overlap. When a `ref` tag
 * arrives on a visit whose referrer **did** survive, the referrer says what the
 * label meant (90 days, bare labels only):
 *
 * | `ref=`        | referrer beside it | events |
 * | ------------- | ------------------ | ------ |
 * | `producthunt` | `producthunt.com`  | 396    |
 * | `bharathunt`  | `bharathunt.org`   | 8      |
 * | `peerlist`    | `peerlist.io`      | 6      |
 *
 * So `REF_SOURCE_ALIASES` below is **seeded from measurement rather than from taste**, and
 * the guess a naive implementation would make is exactly the one the data
 * refutes: appending `.com` would have filed Peerlist and BharatHunt under hosts
 * that are not theirs. A label with no measured host therefore keeps **itself**
 * as the key — see `refSourceOf` — rather than being decorated into a domain
 * nobody verified.
 *
 * ## What it does not do
 *
 * It never overrides a referrer the browser actually sent, and never fills a
 * self-referral: an internal navigation whose URL kept the landing page's `?ref`
 * is not a second acquisition. Both guards live in the collector, on the one line
 * that decides (`apps/collector/src/events.ts`), because they are the same guards
 * `clickIdSourceOf` is called behind.
 */

/**
 * Bare `ref` labels whose host production has actually seen beside them.
 *
 * Two kinds of entry, and the bar for each is stated so a future addition is a
 * decision rather than a habit:
 *
 * - **Measured** — the label and the host co-occurred on real visits (the table
 *   in the module header). The threshold is five co-occurring events, which is
 *   the difference between "this label means this site" and one visitor who
 *   arrived through an aggregator that syndicates the link.
 * - **Household names a customer types by hand.** `?ref=twitter` is what a
 *   person writes on their own link, and the docs page tells them to; mapping it
 *   onto `x.com` puts their tagged traffic in the same row as the referrals X
 *   still reports itself, which is the whole point of a grouping key.
 *
 * Every value is written in canonical form already, and `refSourceOf` puts it
 * through `canonicalReferrerHost` anyway — the call is the guard that keeps this
 * table honest, not a transformation anyone relies on. A test pins it.
 *
 * Adding an entry later is a data change that affects **new data only** (D-R4):
 * rows already written keep the key they were written with, so a late addition
 * shows as a step, never as a rewrite.
 */
export const REF_SOURCE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Measured on production, 90 days.
  producthunt: 'producthunt.com',
  bharathunt: 'bharathunt.org',
  peerlist: 'peerlist.io',
  // Household names, for links a person tags by hand.
  twitter: 'x.com',
  x: 'x.com',
  hn: 'news.ycombinator.com',
  hackernews: 'news.ycombinator.com',
  reddit: 'reddit.com',
  linkedin: 'linkedin.com',
  facebook: 'facebook.com',
  instagram: 'instagram.com',
  youtube: 'youtube.com',
  tiktok: 'tiktok.com',
  github: 'github.com',
  gitlab: 'gitlab.com',
  telegram: 'telegram.org',
  discord: 'discord.com',
  slack: 'slack.com',
  medium: 'medium.com',
  substack: 'substack.com',
  devto: 'dev.to',
  bluesky: 'bsky.app',
  bsky: 'bsky.app',
  indiehackers: 'indiehackers.com',
  google: 'google.com',
  chatgpt: 'chatgpt.com',
  openai: 'chatgpt.com',
  claude: 'claude.ai',
  perplexity: 'perplexity.ai',
  gemini: 'gemini.google.com',
})

/**
 * Canonical domains of AI assistants whose outbound links carry `utm_source` or
 * `utm_medium` tags (e.g. `utm_source=chatgpt.com`, `utm_source=Claude AI` with
 * `utm_medium=claude.ai`), keyed by both bare normalized names and hostnames.
 */
const AI_UTM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  chatgpt: 'chatgpt.com',
  openai: 'chatgpt.com',
  'chatgpt.com': 'chatgpt.com',
  'chat.openai.com': 'chatgpt.com',
  'openai.com': 'chatgpt.com',
  claude: 'claude.ai',
  claudeai: 'claude.ai',
  anthropic: 'claude.ai',
  'claude.ai': 'claude.ai',
  'anthropic.com': 'claude.ai',
  perplexity: 'perplexity.ai',
  perplexityai: 'perplexity.ai',
  'perplexity.ai': 'perplexity.ai',
  gemini: 'gemini.google.com',
  googlegemini: 'gemini.google.com',
  'gemini.google.com': 'gemini.google.com',
  copilot: 'copilot.microsoft.com',
  microsoftcopilot: 'copilot.microsoft.com',
  'copilot.microsoft.com': 'copilot.microsoft.com',
  grok: 'grok.com',
  'grok.com': 'grok.com',
  'x.ai': 'grok.com',
  'grok.x.ai': 'grok.com',
  deepseek: 'deepseek.com',
  'deepseek.com': 'deepseek.com',
  'chat.deepseek.com': 'deepseek.com',
  mistral: 'mistral.ai',
  lechat: 'mistral.ai',
  'mistral.ai': 'mistral.ai',
  'chat.mistral.ai': 'mistral.ai',
  qwen: 'qwen.ai',
  'qwen.ai': 'qwen.ai',
  'chat.qwen.ai': 'qwen.ai',
  metaai: 'meta.ai',
  'meta.ai': 'meta.ai',
})

function resolveAiUtmField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const raw = value.trim().toLowerCase()
  if (raw === '' || raw === PII_REDACTED.toLowerCase()) return null
  const host = canonicalReferrerHost(raw)
  if (host !== '' && Object.hasOwn(AI_UTM_ALIASES, host)) {
    return AI_UTM_ALIASES[host] ?? null
  }
  const key = raw.replace(/[^a-z0-9]/g, '')
  if (key !== '' && Object.hasOwn(AI_UTM_ALIASES, key)) {
    return AI_UTM_ALIASES[key] ?? null
  }
  return null
}

/**
 * The canonical assistant domain named by `utm_source` / `utm_medium` when a
 * link from an AI assistant app arrives with no HTTP `Referer`. Returns `null`
 * for ordinary campaign tags (`utm_source=newsletter`, etc.).
 */
export function aiUtmSourceOf(attribution: {
  readonly utm_source?: string | null | undefined
  readonly utm_medium?: string | null | undefined
}): string | null {
  return resolveAiUtmField(attribution.utm_source) ?? resolveAiUtmField(attribution.utm_medium)
}

/**
 * The longest `ref` value considered at all, before normalization.
 *
 * Long enough for any host and any label a human writes, short enough that a
 * sprayed query parameter cannot push arbitrary text into a `LowCardinality`
 * grouping key.
 */
const MAX_RAW_LENGTH = 128

/** The stored label's cap, which is also `ref_source`'s contract maximum. */
const MAX_LABEL_LENGTH = 64

/**
 * A label that may stand in for a host: lowercase alphanumerics with the
 * separators a slug uses. No dots (a dotted value took the host branch), no
 * spaces, no brackets — which is also what keeps `[redacted]` out, belt and
 * braces beside the explicit check.
 */
const LABEL = /^[a-z0-9][a-z0-9_+-]{0,63}$/

/**
 * A hostname: dot-separated labels, at least two of them, no underscores.
 * Applied *after* `canonicalReferrerHost`, so what it judges is the exact string
 * that would be stored.
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** A source named by a `ref` tag, and the tag that named it. */
export interface RefSource {
  /** The grouping key: a canonical host, or the label itself when no host is known. */
  readonly domain: string
  /**
   * The normalized `ref` value that produced it — stored so an inference stays
   * auditable, and so a mapping that turns out wrong is found with one GROUP BY
   * rather than by re-deriving it from stored URLs.
   */
  readonly value: string
}

/** Reads `ref` case-insensitively: a CMS or link shortener may re-case a key. */
function refValueOf(sanitized: SanitizedUrl): string | null {
  for (const [key, value] of Object.entries(sanitized.query)) {
    if (key.toLowerCase() !== 'ref') continue
    const trimmed = value.trim().toLowerCase()
    return trimmed === '' ? null : trimmed
  }
  return null
}

/**
 * The host inside a value that carries one: `https://selfh.st/`, `selfh.st/`,
 * `toolhunt.eu/`.
 *
 * Not hypothetical — production holds both shapes, because a linking site that
 * builds its `ref` from its own canonical URL leaves the scheme and the trailing
 * slash in it. Values reach here already percent-decoded: `SanitizedUrl.query`
 * comes from `URLSearchParams`, so the stored `%2f` is a `/` by the time this
 * module sees it.
 */
function hostInside(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).host
  } catch {
    return ''
  }
}

/**
 * The source a sanitized landing URL's `?ref=` names, or `null`.
 *
 * Resolution order, and each step exists because production produced a value it
 * had to answer for:
 *
 * 1. `[redacted]` is **not a source.** 80 events in 30 days carry it: a `ref`
 *    whose value tripped the opaque-token rule. Storing it would create a
 *    "[redacted]" row in every customer's Sources report, which reads as a
 *    defect in the product rather than as the honest absence it is.
 * 2. A value carrying a URL or a slash resolves to its **host**.
 * 3. A dotted value **is** a host: `selfh.st`, `land-book.com`,
 *    `n.mumingfang.com` — the majority of the tail.
 * 4. A bare label with a measured or household host maps onto that host, so the
 *    tagged visits and the ones whose referrer survived land in one row.
 * 5. Any other bare label **keeps itself** as the key. It names a source we
 *    cannot spell as a host, and the alternative — guessing a TLD — is the
 *    mistake the measurement in the module header refutes.
 *
 * Anything else derives nothing and the visit stays Direct, which is the answer
 * that was already true.
 */
export function refSourceOf(sanitized: SanitizedUrl | null): RefSource | null {
  if (sanitized === null) return null

  const raw = refValueOf(sanitized)
  if (raw === null || raw.length > MAX_RAW_LENGTH) return null
  if (raw === PII_REDACTED.toLowerCase()) return null

  const value = raw.slice(0, MAX_LABEL_LENGTH)

  if (raw.includes('/') || raw.includes(':')) {
    const host = canonicalReferrerHost(hostInside(raw))
    return HOSTNAME.test(host) ? { domain: host, value } : null
  }

  if (raw.includes('.')) {
    const host = canonicalReferrerHost(raw)
    return HOSTNAME.test(host) ? { domain: host, value } : null
  }

  // `Object.hasOwn`, not a bare index: the table is a plain object, so
  // `?ref=constructor` would otherwise find `Object`'s own constructor on the
  // prototype chain and hand a FUNCTION to `canonicalReferrerHost`, which
  // throws — a 500 on the ingest path, mintable by anyone with a URL.
  const alias = Object.hasOwn(REF_SOURCE_ALIASES, raw) ? REF_SOURCE_ALIASES[raw] : undefined
  if (alias !== undefined) {
    const host = canonicalReferrerHost(alias)
    return host === '' ? null : { domain: host, value }
  }

  return LABEL.test(raw) ? { domain: raw, value } : null
}
