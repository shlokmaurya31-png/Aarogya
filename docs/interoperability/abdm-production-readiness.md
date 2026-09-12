# ABDM Production Readiness

Phase C6. Assessed 2026-09-12 against the state of this repository.

**Verdict: NOT PRODUCTION READY. Blocked on external onboarding, not on code.**

Every row below is `READY`, `BLOCKED`, `NOT_VERIFIED` or `NOT_APPLICABLE`. There
is no "partially ready".

---

## 1. Summary

| Dimension | State |
|---|---|
| Architecture | READY |
| Contract | READY (M3 v2.5, read directly) |
| Configuration model | READY |
| Credentials | **BLOCKED** — none exist for this repository |
| Sandbox transport | READY (proven live, see §3) |
| Sandbox authenticated exchange | **BLOCKED** — no credentials |
| Production | **NOT_VERIFIED** — never attempted, and correctly so |

---

## 2. Item by item

| Item | State | Evidence / blocker |
|---|---|---|
| Adapter boundary | READY | `interoperability/adapters/abdm.ts`, `abdm/client.ts` |
| Protocol contract | READY | ABDM M3 Sandbox Documentation v2.5 (NHA, 2025-03-03), read directly from the published PDF; pinned in `abdm/contract.ts` and frozen by `contract.test.ts` |
| Endpoints, headers, grant type | READY | verified from the same document, not inferred |
| Environment separation | READY | `sbx`/`abdm` CM ids and ABHA suffixes are distinct; C3 client refuses PRODUCTION outright |
| Session / token handling | READY | `abdm/session.ts`; 400-on-bad-credentials correctly classified as AUTHENTICATION (found live in C3) |
| Rate limiting | READY | `abdm/rateLimit.ts`, conservative, throws rather than sleeping |
| Consent mapping | READY | 6 purpose codes, 7 hiTypes; lossy mappings flagged, `BILLING` reported unsupported rather than dropped |
| Callback verification | READY | shared secret, constant-time, ±10 min window, correlation to an exchange we started, DB-unique replay guard |
| Protocol state machine | READY | separate from local exchange status; terminal decisions are terminal |
| FHIR DocumentBundle | READY (structural) | R4 4.0.1; **profile validation against ABDM StructureDefinitions is NOT performed** — see [`phase-c-readiness.md`](./phase-c-readiness.md) §3 |
| Control-plane registration | READY | C6 registry, readiness model, kill switch, audit |
| Participant registry | READY | HIP/HIU counterparties, trust separate from identity |
| Certificate lifecycle | READY (metadata) | status, expiry, staged rotation — **records** rotation, does not perform it |
| Monitoring | READY | metrics, deterministic alerts, exchange timeline |
| Incident handling | READY | emergency kill switch, runbook, audited refusals |
| **Client credentials** | **BLOCKED** | all `ABDM_*` variables unset. No credential exists for this repository. |
| **Bridge / service registration** | **BLOCKED** | requires NHA onboarding; Bridge ID and Service ID are issued externally |
| **Public HTTPS callback host** | **BLOCKED** | ABDM must reach a public endpoint; none is provisioned |
| **X.509 certificates** | **BLOCKED** | none issued; the control plane can record metadata once they exist |
| **Sandbox ABHA test address** | **BLOCKED** | required to exercise a real consent flow end to end |
| **M1 (ABHA) specification** | **BLOCKED** | document not obtained; no code written, capability not claimed |
| **M2 (HIP) specification** | **BLOCKED** | document not obtained; no code written, capability not claimed |
| **ECDH health-information push** | **NOT_VERIFIED** | crypto parameters pinned from M3; key agreement deliberately not implemented. Capability reports `DOMAIN_ONLY`. |
| **Production enablement** | **NOT_VERIFIED** | no production call has ever been made. `productionVerifiedAt` is null and can only be set by a genuine handshake. |

---

## 3. What was genuinely proven live

In C3, against the real host `dev.abdm.gov.in`, with a deliberately invalid
client id:

| Call | Result |
|---|---|
| `GET /gateway/v3/.well-known/openid-configuration` | **HTTP 200** |
| `GET /gateway/v3/certs` | **HTTP 200** |
| `POST /gateway/v3/sessions` | **HTTP 400 `ABDM-9999` "Invalid user credentials"** |

The 400 is the useful result: a *domain* rejection proves the URL, headers, body
shape and grant type are all correct. Network egress to the ABDM sandbox works
from the verification machine.

This is transport verification. It is **not** authenticated exchange, and no
part of the product reports it as such.

---

## 4. What must happen before production

**Outside this codebase, and blocking:**

1. NHA onboarding: bridge registration, Bridge ID, Service ID.
2. Production client credentials, held in the deployment's secret store.
3. A public HTTPS callback host reachable by ABDM.
4. X.509 certificates issued for signing and TLS.
5. The M1 and M2 specifications, if ABHA creation or HIP capability is wanted.

**Inside this codebase, once the above exist:**

1. Configure the integration for `PRODUCTION` (facility admin).
2. Obtain approval from a second authorised user (`interop:integration:approve`).
3. Enable it.
4. Run a real handshake. Only that writes `productionVerifiedAt`.
5. Register the certificates' metadata and set expiry monitoring.
6. Re-run `scripts/verify-postgres-abdm-integration.ts` against the live target.

Implementing ECDH payload encryption is additional work, and is the only item on
this list that is a genuine code gap rather than an onboarding gap.

---

## 5. What is deliberately not claimed

No ABDM certification. No statement of conformance to ABDM StructureDefinitions.
No claim that authenticated sandbox exchange has occurred. Implementing controls
is not the same as being certified, and certification is an external
determination this repository cannot make about itself.
