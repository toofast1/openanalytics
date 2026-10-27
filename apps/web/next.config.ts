import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

/**
 * The hosted deployment's payment provider returns the browser to
 * `${APP_BASE_URL}/billing/success|cancel` (apps/api/src/cloud/http/billing.ts);
 * the page itself lives under `/dashboard`. Coming back is not confirmation
 * either way — the billing board re-reads `GET /v1/billing`, which only the
 * webhook updates.
 *
 * The rule is added only when those routes are in the tree, which is the same
 * switch the `@seam/slots` alias uses: a build without `app/(cloud)/` has
 * nothing at `/dashboard/billing`, and a redirect into a 404 is worse than no
 * redirect. Checked on disk rather than behind a flag, so there is one fact to
 * get wrong instead of two.
 */
const hasCloudRoutes = existsSync(path.join(__dirname, "app", "(cloud)"));

const nextConfig: NextConfig = {
  // Pin the workspace root to the monorepo root. Without this, Next infers it
  // from whatever lockfile it finds on disk and can pick one outside the repo.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  // Since 16.4, `next dev` writes an AGENTS.md of its own into apps/web and
  // re-creates it when deleted. The repository's AGENTS.md is the one place
  // its rules live; a second, generated one beside it is a disagreement
  // waiting to happen and an untracked file in every contributor's tree.
  agentRules: false,
  /**
   * Serve AVIF where the browser says it can read it.
   *
   * The source files in `public/` are AVIF now, which is what makes the repo
   * and the deploy small. This line is the other half: without it Next's
   * default is `["image/webp"]`, so every browser — including the ones that
   * asked for AVIF in their `Accept` header — would be handed a WebP
   * transcode of an AVIF original, paying the conversion and losing the
   * format's advantage.
   *
   * It is also the answer to "does every browser support AVIF". Not quite:
   * Safari only from 16, and there are older Android WebViews. But the
   * optimizer negotiates per request, so a browser that never advertises
   * AVIF is served the WebP entry instead and no one sees a broken image.
   * The rule this depends on: every local image goes through `next/image`.
   * A raw `<img src="…​.avif">` would skip the negotiation and break on
   * exactly those old browsers, which is why the two `<img>` tags in this
   * app both point at external favicons rather than our own files.
   */
  images: {
    formats: ["image/avif", "image/webp"],
  },
  // The api's Stripe return URLs are `${APP_BASE_URL}/billing/success|cancel`
  // (apps/api/src/http/billing.ts); the page itself lives under /dashboard.
  // Coming back is not confirmation either way — the billing board re-reads
  // GET /v1/billing, which only the webhook updates.
  redirects: async () =>
    hasCloudRoutes
      ? [
          {
            source: "/billing/:path*",
            destination: "/dashboard/billing",
            permanent: false,
          },
        ]
      : [],
};

export default nextConfig;
