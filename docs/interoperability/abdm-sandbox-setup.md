# ABDM Sandbox Setup

How to take this deployment from `DISABLED` to a genuinely verified sandbox
connection.

> **Current status: EXTERNALLY BLOCKED.** No step below has been completed for
> this repository. No ABDM credential exists, no bridge is registered, and no
> call has ever been made to any ABDM environment.

## Status vocabulary

These terms are used precisely throughout the interoperability docs:

| Term | Means |
| --- | --- |
| **LOCAL IMPLEMENTATION** | Code exists and is tested. No external dependency. |
| **SANDBOX READY** | The contract is implemented; only credentials are missing. |
| **SANDBOX VERIFIED** | A real call to `dev.abdm.gov.in` succeeded. |
| **PRODUCTION READY** | Verified against `apis.abdm.gov.in` with production onboarding. |
| **EXTERNALLY BLOCKED** | Cannot proceed without something outside this repo. |

Nothing in Aarogya is SANDBOX VERIFIED or PRODUCTION READY.

## Prerequisites (all external)

1. **ABDM sandbox account** — register at the ABDM sandbox portal.
2. **Bridge / client registration** — NHA issues a client id shaped `SBX_XXXXXX`
   plus a client secret. This is the *integrator* identity, one per deployment.
3. **Facility registration (HFR)** — each facility needs a service id shaped
   `IN02100000XX` from the NHPR/HFR.
4. **Public HTTPS callback host** — the CM must be able to reach this deployment.
   Not required to make outbound calls; required to receive consent
   notifications or health information.
5. **Milestone completion** — ABDM gates capabilities behind M1/M2/M3
   certification.

## Configuration

```bash
# Start here. DISABLED means zero external calls; the hospital is unaffected.
ABDM_ENVIRONMENT=DISABLED

# ── When sandbox credentials exist ──────────────────────────────────────────
ABDM_ENVIRONMENT=SANDBOX
ABDM_CLIENT_ID=SBX_XXXXXX          # bridge id from NHA
ABDM_CLIENT_SECRET=...             # NEVER commit; secret manager only

# Optional; defaults to the documented per-environment base URL.
# Only set this to point at a proxy or mirror.
ABDM_BASE_URL=https://dev.abdm.gov.in

# ── Only if receiving callbacks ─────────────────────────────────────────────
ABDM_CALLBACK_BASE_URL=https://your-host.example    # must be https
ABDM_CALLBACK_TOKEN=<long random value>             # shared secret we require

# Optional tuning (clamped to 1s–120s).
ABDM_REQUEST_TIMEOUT_MS=30000

# Only if a future flow requires mutual TLS. PATHS ONLY — never contents.
ABDM_CLIENT_CERT_PATH=/run/secrets/abdm-client.crt
ABDM_CLIENT_KEY_PATH=/run/secrets/abdm-client.key
ABDM_CA_BUNDLE_PATH=/run/secrets/abdm-ca.pem
```

`ABDM_BASE_URL` is resolved automatically from `ABDM_ENVIRONMENT`
(`SANDBOX → https://dev.abdm.gov.in`, `PRODUCTION → https://apis.abdm.gov.in`),
along with the `X-CM-ID` suffix. Overriding it raises a configuration warning,
because pointing the wrong consent-manager suffix at the wrong environment makes
every ABHA address silently invalid.

## Verifying

```bash
# 1. Configured state only — makes NO network call.
GET /api/hospital/interoperability/abdm/connection-test

# 2. Real handshake. Requires interop:connection:manage. Audited.
POST /api/hospital/interoperability/abdm/connection-test
```

Interpreting the result — `state` is the whole answer:

| State | Meaning |
| --- | --- |
| `DISABLED` | Switched off. Not an error. |
| `MISCONFIGURED` | Enabled but incomplete, or environment mismatch. |
| `UNREACHABLE` | Configured; gateway did not answer. |
| `AUTHENTICATION_FAILED` | Gateway answered and rejected the credentials. |
| `UNKNOWN` | Configuration complete, **but nothing proven**. |
| `AVAILABLE` | A real session handshake succeeded. |

**`AVAILABLE` is the only state that means connected**, and it is only ever
returned after a live handshake. A complete configuration reports `UNKNOWN`, on
purpose — code existing is not connectivity.

## Callback registration

Once `ABDM_CALLBACK_BASE_URL` is set, the paths this deployment exposes are:

| Kind | Path |
| --- | --- |
| `consentRequestOnInit` | `/api/hospital/interoperability/abdm/callback/consentRequestOnInit` |
| `consentRequestNotify` | `/api/hospital/interoperability/abdm/callback/consentRequestNotify` |
| `consentRequestOnStatus` | `/api/hospital/interoperability/abdm/callback/consentRequestOnStatus` |
| `consentOnFetch` | `/api/hospital/interoperability/abdm/callback/consentOnFetch` |
| `healthInformationOnRequest` | `/api/hospital/interoperability/abdm/callback/healthInformationOnRequest` |

`GET .../connection-test` returns the fully-qualified list.

Registering the base URL with ABDM (`/api/hiecm/gateway/v3/bridge/url`) requires
a registered bridge and is **not implemented** — see the contract matrix.

> **Callbacks are refused unless `ABDM_CALLBACK_TOKEN` is set.** ABDM does not
> specify a signature over callback bodies, so the shared secret is what
> actually protects this public endpoint. An unset token fails closed.

## Secrets

Never commit, and never place in Prisma, seed data, tests, the frontend, source
code or documentation:

`ABDM_CLIENT_SECRET`, `ABDM_CALLBACK_TOKEN`, any certificate or private key,
any gateway access token.

Aarogya persists none of these. `InteropConnection.clientIdEnvVar` stores the
*name* of an environment variable; the connections route rejects any request
body containing a secret-shaped field.

## Certificate rotation

If a future ABDM flow requires mutual TLS:

1. Write new material to the secret store.
2. Update the `*_PATH` variables to the new location.
3. Restart. Certificates are read at request time from the configured path, so
   there is no in-process cache to invalidate.

Rotation is deliberately operator-driven. No automated certificate manager is
built, and none should be added without a verified requirement.

## Testing without credentials

`src/lib/hospital/interoperability/adapters/mockAbdm.ts` provides
`createMockAbdmFetch()`, which scripts `SUCCESS`, `TIMEOUT`, `AUTH_FAILURE`,
`VALIDATION_FAILURE`, `CONSENT_FAILURE`, `RATE_LIMITED`, `SERVER_ERROR`,
`NETWORK_ERROR`, `MALFORMED_BODY` and `DUPLICATE_REQUEST`.

It is injected only through the `fetchImpl` test parameter, every response it
produces carries `__mock: true`, and its tokens are prefixed `mock-access-token-`.
**It can never make a health check return `AVAILABLE` for a real deployment**,
and it is not reachable from any production code path.
