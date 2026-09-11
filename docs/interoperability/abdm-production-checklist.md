# ABDM Production Deployment Checklist

Everything that must be true before this deployment talks to
`apis.abdm.gov.in`. Nothing on this list has been completed.

> **Do not set `ABDM_ENVIRONMENT=PRODUCTION` until every item in sections 1–4 is
> checked.** The configuration guard refuses an incomplete production selection,
> but it cannot detect an incomplete *onboarding*.

## 1. ABDM onboarding (external)

- [ ] ABDM production account approved by NHA
- [ ] Milestone 1 certification (ABHA) completed, if ABHA flows are used
- [ ] Milestone 2 certification (HIP) completed, if sharing records
- [ ] Milestone 3 certification (HIU) completed, if consuming records
- [ ] Production bridge / client registered; client id + secret issued
- [ ] Each facility registered in HFR; service id recorded per facility
- [ ] Practitioners registered in HPR, where required by the flow

## 2. Network and DNS

- [ ] Public HTTPS host for callbacks, resolvable from ABDM infrastructure
- [ ] Valid TLS certificate (not self-signed); auto-renewal configured
- [ ] Callback base URL registered with ABDM (`/gateway/v3/bridge/url`)
- [ ] Egress to `apis.abdm.gov.in` permitted by firewall/proxy
- [ ] Timeouts tuned (`ABDM_REQUEST_TIMEOUT_MS`) for real gateway latency

## 3. Secrets

- [ ] `ABDM_CLIENT_SECRET` in a secret manager, **not** in `.env` or git
- [ ] `ABDM_CALLBACK_TOKEN` generated with a CSPRNG, ≥ 32 bytes
- [ ] Certificate/key paths point at the secret store, if mutual TLS is required
- [ ] Secret rotation procedure documented and rehearsed
- [ ] Repository scanned: no credential, token or certificate committed
- [ ] Log pipeline verified to contain no token, key or clinical payload

## 4. Configuration safety

- [ ] `ABDM_ENVIRONMENT=PRODUCTION` **and** `NODE_ENV=production` — the guard
      refuses a production build pointed at SANDBOX and vice versa
- [ ] `ABDM_BASE_URL` left unset so the documented URL resolves automatically
- [ ] `POST /abdm/connection-test` returns `AVAILABLE` against production
- [ ] ABHA addresses use the `@abdm` suffix (sandbox `@sbx` handles are invalid)

## 5. Consent and clinical governance

- [ ] Patient-facing consent language reviewed against the Health Data
      Management Policy
- [ ] Local purpose → ABDM purpose-code mapping reviewed by the data-protection
      owner. Four local purposes collapse to `CAREMGT`; confirm this is acceptable
- [ ] `BILLING` scope confirmed as *not exchangeable* over ABDM
- [ ] Consent revocation procedure documented, including that Aarogya cannot
      recall records already delivered to a recipient
- [ ] External consent status synchronisation reviewed — `reconcileConsentStatus`
      blocks when the CM view is missing or unrecognised

## 6. FHIR conformance

- [ ] ABDM StructureDefinition package obtained and bundled
- [ ] `fhir/profiles.ts::validateFhirResource` implemented against it
- [ ] Every produced resource validated; `conformanceAsserted` returns true
- [ ] Terminology mappings populated for diagnoses, medications and lab codes;
      unmapped concepts confirmed to emit text-only rather than a false code

> Until these are done, Aarogya emits **structurally valid R4** and claims no
> ABDM profile conformance.

## 7. Monitoring and audit

- [ ] Alerting on `AUTHENTICATION_FAILED` and sustained `UNREACHABLE`
- [ ] Alerting on callback rejection and replay rates
- [ ] `AbdmCallbackEvent` growth monitored (an unmatched spike means the URL is
      being probed)
- [ ] Audit retention covers `hospital.interop.*`
- [ ] Exchange failure and retry-exhaustion dashboards in place

## 8. Incident response

- [ ] **Kill switch rehearsed**: setting `ABDM_ENVIRONMENT=DISABLED` and
      restarting stops all external exchange, with no clinical impact
- [ ] Credential-compromise runbook: rotate secret, clear session cache, rotate
      callback token, re-register callback URL
- [ ] ABDM outage runbook — see section 9
- [ ] Contact path to NHA support recorded

## 9. Outage behaviour (verify before go-live)

With ABDM unreachable, confirm by test that **none** of these degrade:

- [ ] Patient registration and ADT
- [ ] Emergency care and triage
- [ ] Admission, transfer, discharge
- [ ] Nursing documentation
- [ ] Medication ordering and administration
- [ ] Laboratory and radiology
- [ ] Operating theatre and blood bank
- [ ] Billing
- [ ] Clinical documentation

Only health-information exchange should stop. This is structural — every
external call is outside clinical transactions and the adapter is reachable only
from the exchange service — but it must be *verified*, not assumed.

## 10. Rollback

- [ ] Set `ABDM_ENVIRONMENT=DISABLED` and restart
- [ ] Confirm no clinical workflow is affected
- [ ] In-flight exchanges settle to `FAILED` with a reason; none report delivery
- [ ] Data already delivered to recipients is **not** recalled — Aarogya cannot
      enforce erasure on systems it does not control, and must not claim to

## Go / no-go

Do **not** go live if any of the following is true:

- profile validation is still `NOT_IMPLEMENTED` and conformance is contractually
  required
- `ABDM_CALLBACK_TOKEN` is unset while callbacks are expected
- the connection test has never returned `AVAILABLE` against production
- the outage test in section 9 has not been performed
