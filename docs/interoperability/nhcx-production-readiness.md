# NHCX Production Readiness

Phase C6. Assessed 2026-09-12. Preserves and re-confirms the C5 position.

**Verdict: NHCX TRANSPORT IS NOT IMPLEMENTED, and must not be.**

This is not unfinished work. It is a decision, re-checked in C6 and unchanged.

---

## 1. The position, unchanged from C5

The HCX/NHCX transport contract could not be verified against a primary source:

| Source | Result |
|---|---|
| NRCeS *Implementation Guide for Adoption of FHIR in ABDM and NHCX* (Sept 2024) | retrieved and read |
| NRCeS `hcx-profile` package | retrieved |
| `docs.hcxprotocol.io` | **HTTP 403** |
| `ig.hcxprotocol.io` | **HTTP 403** |
| `nhcx.abdm.gov.in` | client-rendered; publishes no specification content |

C2 committed ABDM endpoint constants only because the official PDF was read
directly. **That bar is not met for NHCX transport.** Implementing guessed
request shapes for a national claims network would produce code that looks
integrated, passes its own tests, fails on contact with the real switch, and
makes every status field in the product a lie.

So `UnverifiedNhcxAdapter` advertises `operations: []` and returns
`NOT_IMPLEMENTED` from every call. `getNhcxAdapter()` returns nothing else.

---

## 2. Verified material

| Item | State | Source |
|---|---|---|
| FHIR version `4.0.1` | VERIFIED | NRCeS implementation guide |
| Claim bundle type `collection` | VERIFIED | NRCeS implementation guide — asserted at runtime in `fhirMapper.ts`; it is **not** the ABDM `document` bundle |
| Profile list | VERIFIED | NRCeS implementation guide |
| Required Bundle elements | VERIFIED | NRCeS implementation guide |

## 3. Unavailable material

| Item | State |
|---|---|
| Endpoint paths | **UNAVAILABLE** |
| Protocol headers | **UNAVAILABLE** |
| Request envelope | **UNAVAILABLE** |
| Callback contract | **UNAVAILABLE** |
| Error-code vocabulary | **UNAVAILABLE** |
| Crypto parameters | **UNAVAILABLE** |
| Participant-code format | **UNAVAILABLE** |
| Onboarding / credentials | **UNAVAILABLE** |

None of these has been guessed, defaulted or stubbed with a plausible value.

---

## 4. What IS implemented

Everything downstream of transport, and it is complete and verified:

| Capability | State | Control-plane label |
|---|---|---|
| Claim package composition from canonical records | IMPLEMENTED | `FHIR_EXPORT` |
| Consent enforcement (INSURANCE purpose) | IMPLEMENTED | `CONSENT` |
| Immutable versioned submissions | IMPLEMENTED | `CLAIM_SUBMISSION` → `DOMAIN_ONLY` |
| Idempotency and dispatch dedup | IMPLEMENTED | `CLAIM_SUBMISSION` → `DOMAIN_ONLY` |
| Pre-authorization records | IMPLEMENTED | `PREAUTH` → `DOMAIN_ONLY` |
| Payer query / response workflow | IMPLEMENTED | `CLAIM_QUERY` → `DOMAIN_ONLY` |
| Callback ledger and replay guard | IMPLEMENTED | `CLAIM_RESPONSE` → `DOMAIN_ONLY` |
| Settlement recording and reconciliation | IMPLEMENTED | `SETTLEMENT` → `DOMAIN_ONLY` |
| Audit | IMPLEMENTED | — |

`DOMAIN_ONLY` is a first-class capability state in the C6 registry precisely so
this distinction is visible in the product rather than buried in a document.

Verified by 111 adversarial PostgreSQL assertions in
`scripts/verify-postgres-nhcx.ts`, re-run green under C6.

---

## 5. What the control plane enforces about NHCX

C6 adds mechanical guards, not just documentation:

- The registry reports `contractVerified: false` with the blocking reason
  attached, and the UI shows it on the Readiness tab.
- `enableIntegration` **refuses** to switch NHCX on: the contract is unverified,
  so there is nothing to enable. Verified by the C6 gate.
- The outbound safety gate refuses NHCX dispatch on every path.
- Readiness can never reach `SANDBOX_VERIFIED` or `PRODUCTION_VERIFIED` for
  NHCX, because those states require timestamps only a real handshake writes.
- No environment flag can substitute the test harness for the shipped adapter.

`NHCX_ENV_VARS` names remain **Aarogya's own and provisional**. They are not a
claim about what NHCX requires.

---

## 6. What would be required to connect

**Outside this codebase, and blocking:**

1. Access to the authoritative HCX/NHCX protocol specification.
2. NHCX participant onboarding: participant code, credentials, sandbox endpoints.
3. The verified callback contract: headers, signature scheme, envelope.
4. The official error-code vocabulary.
5. The crypto parameters.

**Inside this codebase, once the above exist — and only this:**

1. Implement `submit()` / `checkStatus()` against the verified contract, or add
   a sibling adapter and return it from `getNhcxAdapter()`.
2. Replace the provisional environment-variable names with the real ones.
3. Map the official error codes onto the existing categories in `errors.ts`.
4. Set `NHCX_CONTRACT_SOURCE.transportVerified = true`, recording the source.
5. Flip the C6 capability descriptors from `DOMAIN_ONLY` to `IMPLEMENTED`.
6. Run `scripts/verify-postgres-nhcx.ts` against a sandbox.

Nothing above the adapter boundary should need to change. That is what the
boundary is for.

---

## 7. Production

**NOT ENABLED and NOT ENABLE-ABLE.** There is no configuration, no approval and
no override that switches NHCX on while its contract is unverified. This is
enforced in code and asserted by the C6 gate, not merely stated here.

No NHCX certification is claimed.
