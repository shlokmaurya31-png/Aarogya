import type { NextConfig } from "next";
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
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
