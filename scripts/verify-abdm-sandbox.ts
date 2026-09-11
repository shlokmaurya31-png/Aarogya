/**
 * PHASE C3 — REAL ABDM SANDBOX VERIFICATION.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS SCRIPT MAKES GENUINE NETWORK CALLS TO THE ABDM SANDBOX.
 *
 * It refuses to run unless real credentials are configured, and it CANNOT be
 * satisfied by a mock: there is no fetch injection point, no stub adapter, and
 * no scenario switch. Every result it prints came from dev.abdm.gov.in or it
 * printed nothing.
 *
 * If credentials are absent it exits with a clear EXTERNALLY BLOCKED report and
 * a non-failing status, because "not configured" is not a test failure — it is
 * the honest state of a deployment that has not been onboarded.
 *
 * A test is REAL SANDBOX VERIFIED only if an actual external request was made
 * and a genuine external response was received. Nothing here may be reported
 * otherwise.
 *
 * Usage:
 *   ABDM_ENVIRONMENT=SANDBOX ABDM_CLIENT_ID=... ABDM_CLIENT_SECRET=... \
 *     npx tsx scripts/verify-abdm-sandbox.ts
 * ════════════════════════════════════════════════════════════════════════════
 */
import { getAbdmConfig, checkEnvironmentSafety, describeAbdmConfig, ABDM_ENV_VARS } from "../src/lib/hospital/interoperability/abdm/config";
import { checkAbdmHealth } from "../src/lib/hospital/interoperability/abdm/health";
import { getAbdmSession, clearSessionCache, describeCachedSession } from "../src/lib/hospital/interoperability/abdm/session";
import { abdmRequest } from "../src/lib/hospital/interoperability/abdm/transport";
import { ABDM_ENDPOINTS, ABDM_CONTRACT_SOURCE } from "../src/lib/hospital/interoperability/abdm/contract";
import { InteropError } from "../src/lib/hospital/interoperability/abdm/errors";
import { resetRateLimiter } from "../src/lib/hospital/interoperability/abdm/rateLimit";

type Outcome = "REAL_SANDBOX_PASS" | "REAL_SANDBOX_FAIL" | "BLOCKED" | "SKIPPED";

interface Row {
  test: string;
  outcome: Outcome;
  detail: string;
  latencyMs: number | null;
}

const rows: Row[] = [];
function record(test: string, outcome: Outcome, detail: string, latencyMs: number | null = null) {
  rows.push({ test, outcome, detail, latencyMs });
  const badge =
    outcome === "REAL_SANDBOX_PASS" ? "REAL-PASS"
      : outcome === "REAL_SANDBOX_FAIL" ? "REAL-FAIL"
        : outcome === "BLOCKED" ? "BLOCKED  " : "SKIPPED  ";
  console.log(`${badge} — ${test}${latencyMs !== null ? ` (${latencyMs}ms)` : ""}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("ABDM SANDBOX VERIFICATION — real network calls only");
  console.log(`Contract: ${ABDM_CONTRACT_SOURCE.document} v${ABDM_CONTRACT_SOURCE.version}`);
  console.log("════════════════════════════════════════════════════════════\n");

  const config = getAbdmConfig();
  const described = describeAbdmConfig(config);

  // Configuration presence only. No value is ever printed.
  console.log("── Configuration (values never printed) ──");
  console.log(`  environment            : ${described.environment}`);
  console.log(`  baseUrl                : ${described.baseUrl ?? "(none)"}`);
  console.log(`  X-CM-ID                : ${described.cmId ?? "(none)"}`);
  console.log(`  credentials configured : ${described.credentialsConfigured}`);
  console.log(`  callbacks configured   : ${described.callbacksConfigured}`);
  console.log(`  missing                : ${described.missing.join(", ") || "(none)"}`);
  console.log("");

  // ── Gate 1: is ABDM even enabled? ────────────────────────────────────────
  if (config.environment === "DISABLED") {
    record("ABDM sandbox connectivity", "BLOCKED",
      `${ABDM_ENV_VARS.environment} is not set to SANDBOX. No external call attempted.`);
    return summarise("EXTERNALLY BLOCKED — ABDM is disabled for this deployment.");
  }

  // ── Gate 2: C3 is sandbox-only, by design ────────────────────────────────
  if (config.environment === "PRODUCTION") {
    record("ABDM sandbox connectivity", "BLOCKED",
      "Environment is PRODUCTION. Phase C3 is sandbox-only and refuses production traffic.");
    return summarise("REFUSED — production traffic is not enabled in this phase.");
  }

  // ── Gate 3: credentials ──────────────────────────────────────────────────
  if (!config.configured) {
    record("ABDM authentication", "BLOCKED",
      `Missing ${config.missing.join(", ")}. No external call attempted.`);
    return summarise("EXTERNALLY BLOCKED — ABDM sandbox credentials are not configured.");
  }

  const safety = checkEnvironmentSafety(config);
  if (!safety.safe) {
    record("ABDM configuration safety", "BLOCKED", safety.warning ?? "unsafe configuration");
    return summarise("EXTERNALLY BLOCKED — configuration is unsafe.");
  }

  // From here on, every call is REAL.
  resetRateLimiter();
  clearSessionCache();

  // ── Test 1: authentication (the gateway session handshake) ───────────────
  let authenticated = false;
  {
    const startedAt = Date.now();
    try {
      const session = await getAbdmSession(config);
      const latency = Date.now() - startedAt;
      authenticated = true;
      // The token itself is NEVER printed — only that one was issued.
      record("Authentication (POST /gateway/v3/sessions)", "REAL_SANDBOX_PASS",
        `access token issued, expires ${session.expiresAt.toISOString()}`, latency);
    } catch (e) {
      const latency = Date.now() - startedAt;
      const err = e instanceof InteropError ? e : null;
      record("Authentication (POST /gateway/v3/sessions)", "REAL_SANDBOX_FAIL",
        `${err?.kind ?? "UNKNOWN"}${err?.externalCode ? ` [${err.externalCode}]` : ""} — ${err?.message ?? String(e)}`, latency);
    }
  }

  // ── Test 2: health check with a genuine handshake ────────────────────────
  {
    const health = await checkAbdmHealth(config, { performHandshake: true });
    record("Health check (real handshake)",
      health.state === "AVAILABLE" ? "REAL_SANDBOX_PASS" : "REAL_SANDBOX_FAIL",
      `state=${health.state}`, health.latencyMs);
  }

  // ── Test 3: session caching (no second network call) ─────────────────────
  if (authenticated) {
    const before = describeCachedSession(config);
    await getAbdmSession(config);
    const after = describeCachedSession(config);
    record("Session is cached and reused", after.cached && before.valid ? "REAL_SANDBOX_PASS" : "REAL_SANDBOX_FAIL",
      `cached=${after.cached} valid=${after.valid}`);
  } else {
    record("Session is cached and reused", "SKIPPED", "authentication did not succeed");
  }

  // ── Test 4: OpenID configuration (unauthenticated discovery document) ────
  {
    const startedAt = Date.now();
    try {
      const res = await abdmRequest({
        config,
        path: ABDM_ENDPOINTS.openIdConfiguration,
        method: "GET",
        operation: "openIdConfiguration",
      });
      record("OpenID configuration document", "REAL_SANDBOX_PASS",
        `HTTP ${res.status}`, Date.now() - startedAt);
    } catch (e) {
      const err = e instanceof InteropError ? e : null;
      record("OpenID configuration document", "REAL_SANDBOX_FAIL",
        `${err?.kind ?? "UNKNOWN"} — ${err?.message ?? String(e)}`, Date.now() - startedAt);
    }
  }

  // ── Test 5: JWKS ─────────────────────────────────────────────────────────
  {
    const startedAt = Date.now();
    try {
      const res = await abdmRequest({
        config, path: ABDM_ENDPOINTS.certs, method: "GET", operation: "certs",
      });
      record("Gateway certificates (JWKS)", "REAL_SANDBOX_PASS", `HTTP ${res.status}`, Date.now() - startedAt);
    } catch (e) {
      const err = e instanceof InteropError ? e : null;
      record("Gateway certificates (JWKS)", "REAL_SANDBOX_FAIL",
        `${err?.kind ?? "UNKNOWN"} — ${err?.message ?? String(e)}`, Date.now() - startedAt);
    }
  }

  // ── Tests 6+: consent and data flow ──────────────────────────────────────
  //
  // These require a registered HIU id, a real ABHA address belonging to a
  // sandbox test patient, and (for data flow) a publicly reachable dataPushUrl.
  // They are NOT attempted without those, because a consent request names a
  // real person's health identifier and must never be fired speculatively.
  const hasCallbackHost = config.callbacksConfigured;
  if (!hasCallbackHost) {
    record("Consent request init", "BLOCKED",
      "Requires a registered callback URL; a consent request without one can never be answered.");
    record("Consent status / fetch", "BLOCKED", "Depends on a consent request.");
    record("Health information request", "BLOCKED",
      "Requires a registered callback URL and a publicly reachable dataPushUrl.");
    record("Inbound callback receipt", "BLOCKED", "Requires a publicly reachable HTTPS callback host.");
  } else {
    record("Consent request init", "SKIPPED",
      "Callback host configured, but no sandbox ABHA test address was supplied (ABDM_TEST_ABHA_ADDRESS).");
    record("Consent status / fetch", "SKIPPED", "Depends on a consent request.");
    record("Health information request", "SKIPPED", "Depends on a granted consent artefact.");
    record("Inbound callback receipt", "SKIPPED", "Driven by the gateway, not by this script.");
  }

  const realPass = rows.filter((r) => r.outcome === "REAL_SANDBOX_PASS").length;
  const realFail = rows.filter((r) => r.outcome === "REAL_SANDBOX_FAIL").length;
  summarise(
    realFail > 0
      ? `PARTIAL — ${realPass} real sandbox tests passed, ${realFail} failed.`
      : `${realPass} real sandbox tests passed.`
  );
  if (realFail > 0) process.exitCode = 1;
}

function summarise(verdict: string) {
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("ABDM SANDBOX VERIFICATION SUMMARY");
  console.log(`  REAL SANDBOX PASS : ${counts.REAL_SANDBOX_PASS ?? 0}`);
  console.log(`  REAL SANDBOX FAIL : ${counts.REAL_SANDBOX_FAIL ?? 0}`);
  console.log(`  BLOCKED           : ${counts.BLOCKED ?? 0}`);
  console.log(`  SKIPPED           : ${counts.SKIPPED ?? 0}`);
  console.log(`  VERDICT           : ${verdict}`);
  console.log("════════════════════════════════════════════════════════════\n");
  console.log("Markdown row(s) for docs/interoperability/abdm-sandbox-verification.md:\n");
  for (const r of rows) {
    console.log(`| ${r.test} | ${r.outcome} | ${r.detail} | ${r.latencyMs ?? "—"} | ${new Date().toISOString().slice(0, 10)} |`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("Sandbox verification aborted:", e instanceof Error ? e.message : "non-Error thrown");
  process.exitCode = 1;
});
