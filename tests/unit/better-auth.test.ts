import {
  MAGIC_LINK_EXPIRES_IN_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  buildAuthOptions,
  memoryAdapter,
  type BuildAuthOptionsDeps,
} from '@openanalytics/auth'
import { describe, expect, it } from 'vitest'

/**
 * The Better Auth *configuration* is asserted here against the in-memory
 * adapter. The behavioural proof (revoked-session, session fixation,
 * wrong-origin) drives the real handler in tests/integration.
 */

function makeDeps(overrides: Partial<BuildAuthOptionsDeps> = {}): BuildAuthOptionsDeps {
  return {
    database: memoryAdapter({}),
    secret: 'x'.repeat(32),
    productName: 'Acme Metrics',
    trustedOrigins: ['https://app.test'],
    sendVerificationEmail: async () => {},
    loginPage: 'https://app.test/login',
    consentPage: 'https://api.test/oauth/consent',
    deviceVerificationUri: 'https://api.test/oauth/device',
    ...overrides,
  }
}

/**
 * Every scope either discovery document may advertise, written out.
 *
 * Deliberately a literal rather than `[...SUPPORTED_OAUTH_SCOPES]`: importing
 * the constant would assert that the document says what the constant says,
 * which is true of any constant. What is being pinned is the OAuth vocabulary
 * this API decided on — the four reads (ADR-0043), the two account reads and
 * the five writes (ADR-0048 D1) — so a scope leaving the list is a diff a
 * reviewer reads rather than a green run.
 */
const EXPECTED_SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'site:read',
  'analytics:read',
  'realtime:read',
  'revenue:read',
  'team:read',
  'sites:write',
  'funnels:write',
  'events:write',
  'widgets:write',
  'share:write',
]

/** One configured plugin, by its Better Auth id. */
function plugin(id: string, overrides: Partial<BuildAuthOptionsDeps> = {}): unknown {
  return (buildAuthOptions(makeDeps(overrides)).plugins ?? []).find((p) => p.id === id)
}

describe('buildAuthOptions', () => {
  it('configures a 30-day rolling session refreshed at most daily', () => {
    const options = buildAuthOptions(makeDeps())
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30)
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(60 * 60 * 24)
    expect(options.session?.expiresIn).toBe(SESSION_MAX_AGE_SECONDS)
    expect(options.session?.updateAge).toBe(SESSION_UPDATE_AGE_SECONDS)
  })

  it('configures a host-only, HttpOnly, same-site session cookie named oa_session', () => {
    const advanced = buildAuthOptions(makeDeps()).advanced
    expect(advanced?.cookies?.['session_token']?.name).toBe(SESSION_COOKIE_NAME)
    expect(advanced?.defaultCookieAttributes?.httpOnly).toBe(true)
    expect(advanced?.defaultCookieAttributes?.sameSite).toBe('lax')
    // Host-only: no cookie domain is ever set.
    expect(advanced?.defaultCookieAttributes?.domain).toBeUndefined()
    expect(advanced?.crossSubDomainCookies).toBeUndefined()
  })

  it('requires a verified email and does not auto-sign-in on verification', () => {
    const options = buildAuthOptions(makeDeps())
    expect(options.emailAndPassword?.enabled).toBe(true)
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true)
    expect(options.emailVerification?.sendOnSignUp).toBe(true)
    expect(options.emailVerification?.autoSignInAfterVerification).toBe(false)
  })

  it('lets a self-hosted deployment relax verification, and defaults to not', () => {
    // The escape hatch for an install whose mail transport does not work yet.
    // The default above is what production runs — `apps/api` derives this from
    // AUTH_EMAIL_VERIFICATION, which cloud does not set.
    const relaxed = buildAuthOptions({ ...makeDeps(), requireEmailVerification: false })
    expect(relaxed.emailAndPassword?.requireEmailVerification).toBe(false)
    const explicit = buildAuthOptions({ ...makeDeps(), requireEmailVerification: true })
    expect(explicit.emailAndPassword?.requireEmailVerification).toBe(true)
  })

  it('generates UUIDv7 identifiers', () => {
    const generateId = buildAuthOptions(makeDeps()).advanced?.database?.generateId
    expect(typeof generateId).toBe('function')
    if (typeof generateId === 'function') {
      const id = (generateId as () => string)()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })

  it('returns the user timezone on the session but refuses to write it', () => {
    // ADR-0026. Declaring the column here is what puts it on the session
    // response the frontend already fetches, so the dashboard knows which clock
    // to draw in without a round trip before its first chart. `input: false`
    // keeps the auth surface read-only for it: sign-up and `updateUser` would
    // both accept an unvalidated string, and the only writer that checks the
    // identifier against the runtime's tz database is PATCH /v1/me/preferences.
    const field = buildAuthOptions(makeDeps()).user?.additionalFields?.['timezone']
    expect(field).toBeDefined()
    expect(field?.type).toBe('string')
    expect(field?.required).toBe(false)
    expect(field?.input).toBe(false)
    expect(field?.returned).not.toBe(false)
  })

  it('offers no social provider without credentials', () => {
    const options = buildAuthOptions(makeDeps())
    expect(options.socialProviders?.google).toBeUndefined()
    expect(options.socialProviders?.github).toBeUndefined()
  })

  it('offers only the providers whose credentials are present', () => {
    const options = buildAuthOptions(
      makeDeps({ social: { google: { clientId: 'gid', clientSecret: 'gsecret' } } }),
    )
    expect(options.socialProviders?.google).toBeDefined()
    expect(options.socialProviders?.github).toBeUndefined()
  })

  it('exposes no magic-link endpoints without the email callback', () => {
    // The plugin list is no longer empty here (ADR-0043 D9 made it
    // unconditional), so the assertion is about the magic link specifically
    // rather than about the list's length — which is what it used to be, and
    // what would now pass for the wrong reason.
    expect(plugin('magic-link')).toBeUndefined()
  })

  it('gates the magic-link plugin on the callback being present', () => {
    expect(plugin('magic-link', { sendMagicLinkEmail: async () => {} })).toBeDefined()
    // The login card's copy says "expires in 15 minutes"; this pins that promise.
    expect(MAGIC_LINK_EXPIRES_IN_SECONDS).toBe(60 * 15)
  })

  it('keeps a magic-link token from ever matching an OAuth state (GHSA-965c-763c-88jm)', () => {
    // Below better-auth 1.7.7, an OAuth `state` is accepted as a magic-link
    // token when both resolve to the same verification identifier: anyone who
    // knows an address starts a social sign-in for it and finishes a magic-link
    // sign-in with the state they were handed — a session for that account, or
    // a falsely verified new one, without the mailbox. The two lines that keep
    // the identifiers apart here are a hashed magic-link token and *no* global
    // `verification.storeIdentifier` (a hashed one re-collides them). Pinned in
    // the shape the advisory needs — social sign-in on beside the magic link —
    // because nothing else would notice either line being "tidied" away.
    const options = buildAuthOptions(
      makeDeps({
        sendMagicLinkEmail: async () => {},
        social: { google: { clientId: 'id', clientSecret: 'secret' } },
      }),
    )
    const magicLink = (options.plugins ?? []).find((p) => p.id === 'magic-link') as
      { options?: { storeToken?: unknown } } | undefined
    expect(magicLink?.options?.storeToken).toBe('hashed')
    expect([undefined, 'plain']).toContain(options.verification?.storeIdentifier)
  })

  it('routes verification email through the injected callback only', async () => {
    const sent: { to: string; url: string; token: string }[] = []
    const options = buildAuthOptions(
      makeDeps({
        sendVerificationEmail: async (input) => {
          sent.push(input)
        },
      }),
    )

    const callback = options.emailVerification?.sendVerificationEmail
    expect(typeof callback).toBe('function')
    if (typeof callback === 'function') {
      const invoke = callback as (data: {
        user: { email: string }
        url: string
        token: string
      }) => Promise<void>
      await invoke({
        user: { email: 'person@example.com' },
        url: 'https://api.test/verify?token=tok',
        token: 'tok',
      })
    }

    expect(sent).toEqual([
      { to: 'person@example.com', url: 'https://api.test/verify?token=tok', token: 'tok' },
    ])
  })
})

/**
 * The authorization server (ADR-0043, D9 and D13).
 *
 * Three of these assert something *absent*, which is the class of assertion that
 * most often pins nothing, so each is written against the concrete object the
 * library builds rather than against our own intent.
 */
describe('the authorization server', () => {
  it('mounts all three plugins unconditionally, magic link or not', () => {
    // The conditional spread that used to make `plugins` exist only for the
    // magic link is gone. Without this, a deployment with no magic-link sender
    // — which is every deployment before the outbox is configured — would have
    // no OAuth at all.
    for (const id of ['oidc-provider', 'device-authorization', 'mcp']) {
      expect(plugin(id), `${id} must be on without a magic-link sender`).toBeDefined()
    }
  })

  it('requires PKCE and refuses the plain code challenge', () => {
    // OAuth 2.1. `plain` is a challenge that challenges nothing, and both our
    // clients are public — the exact case PKCE exists for.
    const options = (plugin('oidc-provider') as { options?: Record<string, unknown> }).options
    expect(options?.['requirePKCE']).toBe(true)
    expect(options?.['allowPlainCodeChallengeMethod']).toBe(false)
  })

  it('keeps the library’s registration flag off — DCR is our endpoint, not the library’s (ADR-0047)', () => {
    // F-309 is settled: dynamic registration is live at `POST /v1/oauth/register`,
    // which writes public rows the provider's `getClient` reads. The library's
    // flag stays false as the second lock: the endpoint it would open registers
    // *confidential* clients with wildcard-blind redirect validation, and a
    // library upgrade that re-mounts anything behind this flag must find it shut.
    const options = (plugin('oidc-provider') as { options?: Record<string, unknown> }).options
    expect(options?.['allowDynamicClientRegistration']).toBe(false)
  })

  it('offers no library registration endpoint, under either plugin (ADR-0047 D1)', () => {
    // The third application of D13's removal technique, and two deletions with
    // different reasons. `oidc-provider`'s `/oauth2/register` is session-gated,
    // not closed — any logged-in user could register a client — and only ever
    // mints secret-holding `web` clients. `mcp`'s `/mcp/register` was mounted
    // with **no gate at all** (no session, no flag, no https-or-loopback rule)
    // and failed in production only because it writes an `authenticationScheme`
    // field migration 0045 has no column for. There is exactly one registration
    // door, `POST /v1/oauth/register`, and it is not the library's.
    const oidcEndpoints = (plugin('oidc-provider') as { endpoints: Record<string, unknown> })
      .endpoints
    expect(oidcEndpoints['registerOAuthApplication']).toBeUndefined()
    const mcpEndpoints = (plugin('mcp') as unknown as { endpoints: Record<string, unknown> })
      .endpoints
    expect(mcpEndpoints['registerMcpClient']).toBeUndefined()
    // And what each plugin is actually kept for is still there.
    expect(oidcEndpoints['oAuth2authorize']).toBeDefined()
    expect(oidcEndpoints['oAuth2token']).toBeDefined()
    expect(mcpEndpoints['getMcpOAuthConfig']).toBeDefined()
    expect(mcpEndpoints['getMCPProtectedResource']).toBeDefined()
  })

  it('advertises our registration endpoint and the full scope list in both discovery documents (ADR-0047 D7)', () => {
    // A client that cannot *discover* `/v1/oauth/register` cannot use it, and
    // the library's defaults advertise its own (now deleted) endpoints and an
    // OIDC-only scope list. Both documents are overridden through their one
    // seam; asserted on both because they are built by different functions from
    // different options objects.
    //
    // **The whole list, not `toContain('analytics:read')`.** That was the
    // assertion here when ADR-0048's write scopes shipped, and it is true of a
    // document carrying only the read four — which is what went to production
    // for two days (fixed in `5790ee5`) with nothing red. A scope missing from
    // this list never reaches a consent screen, so "some scope is present" is
    // not a claim worth making.
    const withBase = { baseURL: 'https://api.test' }
    const oidc = (plugin('oidc-provider', withBase) as { options?: Record<string, unknown> })
      .options
    const oidcMetadata = oidc?.['metadata'] as Record<string, unknown> | undefined
    expect(oidcMetadata?.['registration_endpoint']).toBe('https://api.test/v1/oauth/register')
    expect(oidcMetadata?.['scopes_supported']).toEqual(EXPECTED_SUPPORTED_SCOPES)

    const mcpOptions = (plugin('mcp', withBase) as unknown as { options?: Record<string, unknown> })
      .options
    const mcpMetadata = mcpOptions?.['metadata'] as Record<string, unknown> | undefined
    expect(mcpMetadata?.['registration_endpoint']).toBe('https://api.test/v1/oauth/register')
    expect(mcpMetadata?.['scopes_supported']).toEqual(EXPECTED_SUPPORTED_SCOPES)
    // Every registered client is public, and the RFC 8414 document a host reads
    // before its token exchange must not promise secret-based methods.
    expect(mcpMetadata?.['token_endpoint_auth_methods_supported']).toEqual(['none'])
  })

  it('registers exactly the two first-party clients, both public and secretless', () => {
    const options = (plugin('oidc-provider') as { options?: Record<string, unknown> }).options
    const clients = options?.['trustedClients'] as
      { clientId: string; type: string; clientSecret?: string }[] | undefined
    expect(clients?.map((client) => client.clientId)).toEqual(['oa-cli', 'oa-mcp'])
    for (const client of clients ?? []) {
      expect(client.type, `${client.clientId} is a public client`).toBe('public')
      expect(client.clientSecret, `${client.clientId} ships no secret`).toBeUndefined()
    }
  })

  it('gives the CLI no redirect URL at all', () => {
    // The device flow has no redirect. A registered one would leave an
    // authorization-code path open on a client that never uses it.
    const options = (plugin('oidc-provider') as { options?: Record<string, unknown> }).options
    const clients = options?.['trustedClients'] as
      { clientId: string; redirectUrls: string[] }[] | undefined
    expect(clients?.find((client) => client.clientId === 'oa-cli')?.redirectUrls).toEqual([])
    expect(
      clients?.find((client) => client.clientId === 'oa-mcp')?.redirectUrls.length,
    ).toBeGreaterThan(0)
  })

  it('offers no device token endpoint, because Better Auth’s issues a session', () => {
    // D13, and the most important assertion in this file. The plugin's own
    // `/device/token` calls `internalAdapter.createSession` and returns
    // `session.token` as `access_token` — a credential that authenticates the
    // whole dashboard, not a scoped read token. Deleting the endpoint rather
    // than blocking the path is what makes this checkable: there is no route to
    // reach, under any spelling.
    const endpoints = (plugin('device-authorization') as { endpoints: Record<string, unknown> })
      .endpoints
    expect(endpoints['deviceToken']).toBeUndefined()
    // And the rest of RFC 8628's user-facing half is still there — the parts
    // worth not re-deriving.
    for (const kept of ['deviceCode', 'deviceVerify', 'deviceApprove', 'deviceDeny']) {
      expect(endpoints[kept], `${kept} is the library's to keep`).toBeDefined()
    }
  })

  it('sends a human to the one login screen and to our own consent page', () => {
    const oidc = (plugin('oidc-provider') as { options?: Record<string, unknown> }).options
    expect(oidc?.['loginPage']).toBe('https://app.test/login')
    expect(oidc?.['consentPage']).toBe('https://api.test/oauth/consent')

    const device = (plugin('device-authorization') as { options?: Record<string, unknown> }).options
    // Absolute, not a path: this string is printed for a person to type into
    // whichever browser they have.
    expect(device?.['verificationUri']).toBe('https://api.test/oauth/device')
  })

  it('declares POST /oauth2/consent exactly once across every plugin', () => {
    // The MCP plugin does not sit *beside* an OIDC provider — it builds one and
    // re-exports its consent endpoint, so mounting both made Better Auth log
    // `Endpoint path conflicts detected` at boot and left which handler answers
    // to registration order. The two providers are separate instances, so the
    // loser would have been configured differently from the winner.
    //
    // Counted over the whole plugin list rather than asserted on `mcp` alone: a
    // fourth plugin that also brings a consent endpoint is the same bug, and
    // this catches it without anybody remembering to look.
    const plugins = buildAuthOptions(makeDeps()).plugins ?? []
    const consentOwners = plugins
      .filter((p) =>
        Object.values(
          (p as { endpoints?: Record<string, { path?: string }> }).endpoints ?? {},
        ).some((endpoint) => endpoint?.path === '/oauth2/consent'),
      )
      .map((p) => p.id)
    expect(consentOwners).toEqual(['oidc-provider'])
  })

  it('hands the MCP plugin the same options as the mounted provider', () => {
    // It builds a provider out of them, and library defaults there would mean
    // `/mcp/authorize` did not know our own clients exist.
    // One build, and identity on the values rather than on the containers: the
    // provider stores its own defaults merged over ours, so the two option
    // objects are never the same object even when nothing has drifted. What is
    // shared is the array we wrote, and `toBe` on it is a claim two
    // separately-written literals could not satisfy.
    const plugins = buildAuthOptions(makeDeps()).plugins ?? []
    const oidc = (
      plugins.find((p) => p.id === 'oidc-provider') as { options: Record<string, unknown> }
    ).options
    const forwarded = (
      plugins.find((p) => p.id === 'mcp') as unknown as {
        options: { oidcConfig: Record<string, unknown> }
      }
    ).options.oidcConfig
    expect(forwarded['trustedClients']).toBe(oidc['trustedClients'])
    expect(forwarded['requirePKCE']).toBe(oidc['requirePKCE'])
    expect(forwarded['allowDynamicClientRegistration']).toBe(oidc['allowDynamicClientRegistration'])
    expect(forwarded['consentPage']).toBe(oidc['consentPage'])

    // Scopes are compared as sets: the MCP plugin prepends the four OIDC scopes
    // to whatever it is handed, and ours already contains them, so its internal
    // list carries duplicates. Harmless — a scope is checked by membership — and
    // not ours to dedupe, but it means the arrays are not identical and saying
    // so here is better than quietly asserting less.
    const unique = (value: unknown): string[] => [...new Set(value as string[])].sort()
    expect(unique(forwarded['scopes'])).toEqual(unique(oidc['scopes']))
  })

  it('accepts a device code only for a client it knows', () => {
    const device = (plugin('device-authorization') as { options?: Record<string, unknown> }).options
    const validate = device?.['validateClient'] as ((id: string) => boolean) | undefined
    expect(validate?.('oa-cli')).toBe(true)
    expect(validate?.('oa-mcp')).toBe(true)
    // Without this, `POST /device/code` accepts any string and the approval page
    // names a client nobody registered.
    expect(validate?.('somebody-elses-app')).toBe(false)
    expect(validate?.('')).toBe(false)
  })
})
