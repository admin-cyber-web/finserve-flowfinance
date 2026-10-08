import type { AuthConfig } from "convex/server";

// Freebuff-signed federated tokens (see freebuff web's
// src/lib/vly-convex-jwt.ts) let a signed-in freebuff.com user carry their
// identity into this project without going through local sign-in. customJwt
// is correct for this provider: freebuff's tokens and JWKS both carry a
// `kid` header, which the customJwt validation path requires.
const freebuffIssuer =
  process.env.VLY_CONVEX_AUTH_ISSUER ?? "https://freebuff.com";

// Discovery/JWKS for this deployment's own tokens are HTTP actions served on
// the deployment's *.convex.site URL (see auth.addHttpRoutes in http.ts).
// CONVEX_SITE_URL is not reliably the site URL in this config's context — it
// can come through as the *.convex.cloud API URL (which serves no HTTP
// actions, so OIDC discovery 404s and every session token fails to verify),
// or be unset. Normalise it to the site domain so token verification works.
const convexSiteDomain = (
  process.env.CONVEX_SITE_URL ??
  "https://little-kookabura-409.convex.cloud"
).replace(/\.convex\.cloud$/, ".convex.site");

export default {
  providers: [
    // Standard Convex Auth provider for this project's own sign-in ("Get
    // Started" email/guest, see src/convex/auth.ts). The deployment
    // self-issues JWTs (iss = CONVEX_SITE_URL, no `kid` header) validated
    // via OIDC discovery at `${domain}/.well-known/openid-configuration`,
    // served by auth.addHttpRoutes() in convex/http.ts. Do NOT convert this
    // entry to `type: "customJwt"` — that path rejects tokens without a
    // `kid` header, so sign-in would silently never confirm and RequireAuth
    // would loop back to /auth forever.
    {
      domain: convexSiteDomain,
      applicationID: "convex",
    },
    {
      type: "customJwt",
      issuer: freebuffIssuer,
      jwks: `${freebuffIssuer}/api/web/.well-known/jwks.json`,
      applicationID: "vly-convex",
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
