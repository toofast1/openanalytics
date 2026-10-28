import {
  ATTRIBUTION_QUERY_KEYS,
  PII_REDACTED,
  REF_SOURCE_ALIASES,
  canonicalReferrerHost,
  refSourceOf,
  resolveReferrer,
  sanitizeUrl,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * A tagged link stops being Direct (ADR-0077, D-R1).
 *
 * Every case below is a value production actually holds. That is the point of
 * the file: the design question this module answers — what a `ref` label means
 * when it is not a hostname — was decided by measurement (the alias table's
 * header), and a test written from imagination would drift away from the shapes
 * that made the decision.
 */

const SITE = { siteDomains: ['example.com'] }

const refOf = (url: string) => refSourceOf(sanitizeUrl(url))

describe('the ref key', () => {
  it('is a key the redactor preserves', () => {
    // A `ref` the drop rule removed would never reach the deriver at all, and
    // the list is checked BEFORE a site's own `redactQueryKeys` — so a customer
    // who marks `ref` sensitive cannot switch their own attribution off without
    // being told.
    expect(ATTRIBUTION_QUERY_KEYS).toContain('ref')

    const sanitized = sanitizeUrl('https://example.com/?ref=producthunt', {
      redactQueryKeys: ['ref'],
    })
    expect(sanitized?.droppedQueryKeys).toEqual([])
    expect(refSourceOf(sanitized)?.domain).toBe('producthunt.com')
  })

  it('matches a re-cased key and normalizes the value', () => {
    expect(refOf('https://example.com/?REF=ProductHunt')).toEqual({
      domain: 'producthunt.com',
      value: 'producthunt',
    })
    expect(refOf('https://example.com/?ref=%20SelfH.st%20')?.domain).toBe('selfh.st')
  })
})

describe('the alias table', () => {
  it('maps every label to a host spelled the way every other row spells it', () => {
    // `referrer_domain` is a rollup grouping key (ADR-0028): a second spelling
    // splits one source into two rows no reader can merge back, and the rollups
    // are additive and never rewritten.
    for (const host of Object.values(REF_SOURCE_ALIASES)) {
      expect(canonicalReferrerHost(host), host).toBe(host)
    }
  })

  it('files a tagged Product Hunt visit under the host its referrals report', () => {
    // The measurement the table is seeded from: over 90 days, 396 visits carried
    // `ref=producthunt` AND a surviving `producthunt.com` referrer. Mapping the
    // label onto the host is what puts the 10,362 tagged visits and those 396 in
    // one row instead of two.
    expect(refOf('https://example.com/?ref=producthunt')?.domain).toBe('producthunt.com')
    expect(refOf('https://example.com/?ref=chatgpt')?.domain).toBe('chatgpt.com')
    expect(refOf('https://example.com/?ref=claude')?.domain).toBe('claude.ai')
    expect(refOf('https://example.com/?ref=perplexity')?.domain).toBe('perplexity.ai')
  })

  it('does not guess a TLD for a label it has not measured', () => {
    // The mistake the data refutes. Appending `.com` would have filed Peerlist
    // and BharatHunt under hosts that are not theirs — production saw
    // `peerlist.io` and `bharathunt.org` beside those labels — so an unknown
    // label keeps ITSELF as the key rather than being decorated into a domain
    // nobody verified.
    expect(REF_SOURCE_ALIASES['peerlist']).toBe('peerlist.io')
    expect(REF_SOURCE_ALIASES['bharathunt']).toBe('bharathunt.org')
    expect(refOf('https://example.com/?ref=agentsnexus')).toEqual({
      domain: 'agentsnexus',
      value: 'agentsnexus',
    })
  })
})

describe('the value shapes production sends', () => {
  it('reads a dotted value as the host it is', () => {
    // The majority of the tail: directories and newsletters that tag with their
    // own domain.
    for (const [value, host] of [
      ['selfh.st', 'selfh.st'],
      ['land-book.com', 'land-book.com'],
      ['n.mumingfang.com', 'n.mumingfang.com'],
      ['www.saaspo.com', 'saaspo.com'],
    ] as const) {
      expect(refOf(`https://example.com/?ref=${value}`)?.domain, value).toBe(host)
    }
  })

  it('pulls the host out of a value that carried a URL or a slash', () => {
    // Both shapes are in production: a linking site that builds its `ref` from
    // its own canonical URL leaves the scheme and the trailing slash in it. The
    // stored form is percent-encoded (`toolhunt.eu%2f`) and arrives here decoded,
    // because `SanitizedUrl.query` comes from `URLSearchParams`.
    expect(refOf('https://example.com/?ref=toolhunt.eu%2F')?.domain).toBe('toolhunt.eu')
    expect(refOf('https://example.com/?ref=https%3A%2F%2Fgithubhelp.com')?.domain).toBe(
      'githubhelp.com',
    )
  })

  it('does not find a label on the prototype of the alias table', () => {
    // `?ref=constructor` on a bare index would return `Object`'s constructor —
    // a function, handed to a string routine that throws. A 500 on the ingest
    // path that anyone could mint with a URL.
    expect(refOf('https://example.com/?ref=constructor')).toEqual({
      domain: 'constructor',
      value: 'constructor',
    })
    expect(refOf('https://example.com/?ref=__proto__')).toBeNull()
  })

  it('keeps a hyphenated label as itself', () => {
    expect(refOf('https://example.com/?ref=densediscovery-362')?.domain).toBe('densediscovery-362')
  })
})

describe('what never becomes a source', () => {
  it('refuses a value the redactor destroyed', () => {
    // 80 events in 30 days. Storing it would put a "[redacted]" row in a
    // customer's Sources report, which reads as a defect in the product rather
    // than as the honest absence it is.
    const sanitized = sanitizeUrl(
      'https://example.com/?ref=user%40example.com%20wrote%20this%20long%20thing',
    )
    expect(sanitized?.query['ref']).toContain(PII_REDACTED)
    expect(refSourceOf(sanitized)).toBeNull()
    expect(refOf(`https://example.com/?ref=${encodeURIComponent(PII_REDACTED)}`)).toBeNull()
  })

  it('refuses an empty tag', () => {
    // `?ref=` is what a broken link template leaves behind, and inferring a
    // source from it would move real Direct traffic into a channel nobody named.
    expect(refOf('https://example.com/?ref=')).toBeNull()
    expect(refOf('https://example.com/?ref=%20')).toBeNull()
  })

  it('refuses text that is neither a host nor a label', () => {
    expect(refOf('https://example.com/?ref=my%20newsletter')).toBeNull()
    expect(refOf(`https://example.com/?ref=${'a'.repeat(200)}`)).toBeNull()
    expect(refOf('https://example.com/?ref=.')).toBeNull()
    expect(refOf('https://example.com/?ref=%2Fpath%2Fonly')).toBeNull()
  })

  it('derives nothing from a landing URL with no tag', () => {
    expect(refOf('https://example.com/?utm_source=news')).toBeNull()
    expect(refSourceOf(null)).toBeNull()
  })
})

describe('the guard a stale tag must not get past', () => {
  it('leaves an internal navigation Direct even when the URL kept the tag', () => {
    // A visitor lands on `/?ref=producthunt` and clicks through to a page whose
    // link carried the parameter along. That is not a second acquisition, and
    // `isSelf` is the guard: only a referrer that resolved to NOTHING may be
    // filled in. The condition is asserted rather than the outcome, because it
    // is the line in the collector that decides.
    const referrer = resolveReferrer('https://example.com/', {
      ...SITE,
      pageUrl: 'https://example.com/pricing',
    })
    expect(referrer.isSelf).toBe(true)
    expect(refOf('https://example.com/pricing?ref=producthunt')?.domain).toBe('producthunt.com')
    expect(referrer.domain === null && !referrer.isSelf).toBe(false)
  })

  it('does not override a referrer the browser actually sent', () => {
    // Production holds 25 visits carrying `ref=producthunt` whose referrer was
    // an aggregator that syndicates Product Hunt links. The aggregator is where
    // the visit came from, and the browser said so.
    const referrer = resolveReferrer('https://app.designerdailyreport.com/list', {
      ...SITE,
      pageUrl: 'https://example.com/',
    })
    expect(referrer.domain).toBe('app.designerdailyreport.com')
    expect(referrer.domain === null && !referrer.isSelf).toBe(false)
  })
})
