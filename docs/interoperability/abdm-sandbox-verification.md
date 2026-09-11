# ABDM Sandbox Verification Record

What was **actually executed against the real ABDM sandbox**, and what remains
blocked. A row is REAL SANDBOX VERIFIED only if a genuine external request was
made to `dev.abdm.gov.in` and a genuine external response was received.

## Environment

| Item | Value |
| --- | --- |
| Environment | `SANDBOX` |
| Base URL | `https://dev.abdm.gov.in` |
| `X-CM-ID` | `sbx` |
| Contract | ABDM Milestone 3 Sandbox Documentation **v2.5** (NHA, 2025-03-03) |
| Contract re-verified | 2026-09-11 — v2.5 confirmed still current |
| FHIR IG | NRCeS FHIR IG for ABDM v6.5.0 (FHIR R4 4.0.1) |
| Date of verification run | 2026-09-11 |
| Client credentials | **NOT AVAILABLE** — no bridge registered for this repository |
| Callback host | **NOT AVAILABLE** — no public HTTPS host configured |

## What was executed

The verification run used a **deliberately invalid client id/secret** for the
express purpose of proving the transport path is live rather than dead code.
No valid credential was fabricated, and no authenticated operation was
performed.

| # | Test | Mock | Real sandbox | Result | Latency | Date |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Network egress to `dev.abdm.gov.in` | ✅ | ✅ | **VERIFIED** — TLS established, gateway answered | ~100–250 ms | 2026-09-11 |
| 2 | `GET /gateway/v3/.well-known/openid-configuration` | ✅ | ✅ | **REAL SANDBOX PASS** — HTTP 200 | 103 ms | 2026-09-11 |
| 3 | `GET /gateway/v3/certs` (JWKS) | ✅ | ✅ | **REAL SANDBOX PASS** — HTTP 200 | 134 ms | 2026-09-11 |
| 4 | `POST /gateway/v3/sessions` — request contract | ✅ | ✅ | **CONTRACT VERIFIED** — gateway parsed our URL, headers and body and returned a *domain* error, not a malformed-request error | 217 ms | 2026-09-11 |
| 5 | `POST /gateway/v3/sessions` — authentication | ✅ | ✅ | **REAL SANDBOX FAIL (expected)** — HTTP 400 `ABDM-9999` "Invalid user credentials" | 217 ms | 2026-09-11 |
| 6 | ABDM error-envelope normalisation | ✅ | ✅ | **VERIFIED** against a genuine `ABDM-9999` envelope | — | 2026-09-11 |
| 7 | Health check truthfulness | ✅ | ✅ | **VERIFIED** — reported `AUTHENTICATION_FAILED`, never `AVAILABLE` | 151 ms | 2026-09-11 |
| 8 | Authenticated session | ✅ | ❌ | **BLOCKED** — no valid bridge credentials | — | — |
| 9 | Consent request init | ✅ | ❌ | **BLOCKED** — needs credentials + registered callback URL | — | — |
| 10 | Consent status / fetch | ✅ | ❌ | **BLOCKED** — depends on a consent request | — | — |
| 11 | Health information request | ✅ | ❌ | **BLOCKED** — needs credentials + public `dataPushUrl` | — | — |
| 12 | Inbound callback receipt | ✅ | ❌ | **BLOCKED** — needs a public HTTPS callback host | — | — |
| 13 | ECDH data push / decryption | ❌ | ❌ | **BLOCKED** — not implemented; needs a live push endpoint | — | — |
| 14 | FHIR profile conformance | ❌ | ❌ | **BLOCKED** — StructureDefinition package not bundled | — | — |

**Real sandbox tests passed: 2. Contract verifications against the live
gateway: 3. Blocked: 7.**

## What test 4 actually proves

This is the most valuable result in the run and deserves precision.

The gateway returned `HTTP 400` with
`{"error":{"code":"ABDM-9999","message":"Invalid user credentials"}}`.

That is a **domain** rejection, not a transport or parsing rejection. To produce
it, the gateway had to accept our TLS connection, route the request to the v3
session handler, accept our `REQUEST-ID`, `TIMESTAMP` and `X-CM-ID` headers,
parse our JSON body, find `clientId`, `clientSecret` and `grantType`, and only
then decide the credentials were wrong.

So the following are verified against the real system:

- the base URL and endpoint path
- the mandatory header set and their exact spellings
- the request body shape and `grant_type: client_credentials`
- the error-envelope format and our normalisation of it

What is **not** verified: that a valid credential would be accepted. That
requires a valid credential.

## Defect found by real interaction

| Sev | Finding | Root cause | Fix |
| --- | --- | --- | --- |
| **P2** | An operator with a wrong client secret saw health state `UNKNOWN` instead of `AUTHENTICATION_FAILED`, sending them to look for a network fault that did not exist. | ABDM answers bad credentials with **HTTP 400**, not 401. The generic status mapping classified that as `VALIDATION_ERROR`, which the health check did not recognise as an auth failure. | `session.ts` now re-classifies a 400 on the session operation as `AUTHENTICATION_ERROR`. Scoped to that one operation, where a 400 of that shape can only mean a credential rejection. Retry behaviour is unchanged — both kinds are non-retryable. Verified against the live gateway. |

This defect was invisible to every mock, because a mock returns whatever status
the author expects. It only surfaced by talking to the real thing — which is
the entire justification for this phase.

## Reproducing

```bash
# Honest report with no credentials (exits 0; "not configured" is not a failure)
npx tsx scripts/verify-abdm-sandbox.ts

# Prove the transport path is live (deliberately invalid credentials)
ABDM_ENVIRONMENT=SANDBOX \
ABDM_CLIENT_ID=SBX_000000 \
ABDM_CLIENT_SECRET=deliberately-invalid \
  npx tsx scripts/verify-abdm-sandbox.ts

# With real credentials, once onboarded
ABDM_ENVIRONMENT=SANDBOX ABDM_CLIENT_ID=... ABDM_CLIENT_SECRET=... \
  npx tsx scripts/verify-abdm-sandbox.ts
```

`scripts/verify-abdm-sandbox.ts` has **no fetch injection point and no mock
path**. It cannot be satisfied by a stub: every result it prints came from the
network or it printed `BLOCKED`.

## Remaining external blockers

1. **ABDM sandbox onboarding** — no account or bridge registration exists.
2. **Bridge credentials** — `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`.
3. **Public HTTPS callback host** — required for every asynchronous flow;
   without it a consent request can never be answered.
4. **Sandbox ABHA test address** — a consent request names a real health
   identifier and must not be fired speculatively.
5. **Milestone 1 / Milestone 2 specifications** — ABHA and HIP flows remain
   `CONTRACT NOT VERIFIED`.
6. **ABDM StructureDefinition package** — profile conformance stays
   `conformanceAsserted: false`.

## Standing rule

Do not edit this file to claim a verification that was not performed. Regenerate
it from a real run of `scripts/verify-abdm-sandbox.ts`, which prints
paste-ready markdown rows for exactly this table.
