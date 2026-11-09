import type { NextConfig } from "next";
import { SESSION_COOKIE } from "./src/lib/auth/sessionCookie";
import { ABDM_CALLBACK_PATHS } from "./src/lib/hospital/interoperability/abdm/contract";

// Baseline hardening that cannot break rendering. A script/style CSP is not
// set here: without nonces it would need 'unsafe-inline' (little value), and
// a nonce CSP forces dynamic rendering — see
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Microphone: voice input in the AI assistant. Nothing uses camera/geolocation.
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // The document pipeline renders PDF pages with pdf.js on @napi-rs/canvas (a
  // native addon); both load from node_modules at runtime, not bundled.
  // (sharp is already on Next's built-in list.)
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Flagship 4 (3): no API response and no signed-in response may be
      // stored by the browser or a service worker. The session cookie marks
      // a signed-in request; Next's immutable /_next/static files are left be.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/((?!_next/static|_next/image).*)", has: [{ type: "cookie", key: SESSION_COOKIE }], headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
      // Flagship 4c: the ward tablet's service worker is always fetched fresh (node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md §8).
      { source: "/ward-sw.js", headers: [{ key: "Content-Type", value: "application/javascript; charset=utf-8" }, { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
  async rewrites() {
    // ABDM appends these protocol-defined paths to our registered callback
    // base URL; the handler lives at a single dynamic route keyed by kind.
    return Object.entries(ABDM_CALLBACK_PATHS).map(([kind, path]) => ({
      source: path,
      destination: `/api/hospital/interoperability/abdm/callback/${kind}`,
    }));
  },
};

export default nextConfig;
