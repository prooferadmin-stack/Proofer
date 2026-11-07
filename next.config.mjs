import { withSentryConfig } from "@sentry/nextjs";

// Security headers on every response (launch hardening, 9.4). The content
// security policy is enforced (launch task 21, 2026-11-07): staging ran it in
// report-only mode from 2026-10-15 and the public pages (home, inquire,
// embed, book, logins) logged nothing it would block. If a page breaks,
// set this back to false to return to report-only while you fix it.
const CSP_ENFORCE = true;

// Sites allowed to show the inquiry form in an iframe (9.3). Every other page
// can't be framed at all. Add an origin here to allow another site.
const EMBED_ORIGINS = ["https://davidmonroephotos.com", "https://www.davidmonroephotos.com"];

const csp = [
  "default-src 'self'",
  // Next.js inlines small bootstrap scripts, and the theme picker runs one
  // before first paint, so inline scripts stay allowed for now.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Gallery photos, videos and product images are presigned R2 URLs.
  "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com",
  "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
  // Browser uploads go straight to R2; errors go to Sentry.
  "connect-src 'self' https://*.r2.cloudflarestorage.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
  "font-src 'self' data:",
  "base-uri 'self'",
  "object-src 'none'",
  // Pay buttons send the client on to Stripe Checkout.
  "form-action 'self' https://checkout.stripe.com",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    // One content-security header set per page, so enforcing later doesn't
    // leave two policies overwriting each other. frame-ancestors is always
    // enforced (browsers ignore it in report-only).
    const cspHeaders = (frameAncestors) =>
      CSP_ENFORCE
        ? [{ key: "Content-Security-Policy", value: `${csp}; frame-ancestors ${frameAncestors}` }]
        : [
            { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}` },
            { key: "Content-Security-Policy-Report-Only", value: csp },
          ];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
      // Nothing can be framed, except the inquiry form on David's own site.
      {
        source: "/:path((?!inquire$).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }, ...cspHeaders("'none'")],
      },
      {
        source: "/inquire",
        headers: cspHeaders(`'self' ${EMBED_ORIGINS.join(" ")}`),
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  disableLogger: true,
});
