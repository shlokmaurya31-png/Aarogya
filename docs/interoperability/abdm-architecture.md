# ABDM Integration Architecture

How Aarogya talks to ABDM, and — more importantly — how it stays a working
hospital when ABDM does not answer.

## 1. Layering

```
Hospital OS (clinical domain, Phase B)          ← canonical, authoritative
        │
        ▼
Interoperability boundary (Phase C1)            ← consent, exchange, provenance,
  consent · exchange · externalIdentity ·         FHIR representation
  provenance · terminology · fhir/
        │
        ▼
ABDM contract layer (Phase C2)                  ← protocol vocabulary + transport
  contract · mapping · errors · config ·
  session · transport · callbacks · health
        │
        ▼
ABDM gateway (HIE-CM)                           ← external, may be absent
```

Each arrow is one-way. The clinical domain has no idea ABDM exists; the
interoperability boundary has no idea what ABDM's wire format is; the contract
layer has no idea what a ward is.

## 2. Internal state vs protocol state

These are deliberately separate state machines.

| Aarogya exchange state | Meaning locally | ABDM protocol stage |
| --- | --- | --- |
| `REQUESTED` | intent recorded, nothing sent | not yet submitted |
| `AUTHORIZED` | locally approved | consent request not yet initiated |
| `PROCESSING` | submitted | awaiting CM callback |
| `COMPLETED` | finished | health information received/delivered |
| `FAILED` | failed locally or refused | rejected by gateway, or never sent |
| `REJECTED` / `CANCELLED` | refused or withdrawn locally | never submitted |

A local exchange exists *before* any ABDM request and survives *after* the
protocol finishes, so collapsing the two would make it impossible to represent
"a transfer we decided not to make". `EXCHANGE_STATE_TO_ABDM_STAGE` in
`abdm/mapping.ts` records the correspondence for operators.

## 3. Two authentications that never mix

| | Aarogya user session | ABDM gateway session |
| --- | --- | --- |
| Subject | a clinician | the deployment (bridge) |
| Mechanism | HMAC cookie, `src/lib/auth/session.ts` | `client_credentials`, `abdm/session.ts` |
| Lifetime | 14 days | minutes |
| Storage | httpOnly cookie | in-memory only |

A doctor being logged in does not make Aarogya an authenticated ABDM client, and
a gateway token grants that doctor nothing. Authorisation for a specific
patient's data still comes from **consent**, never from either token.

The gateway token is deliberately **not persisted**: it is short-lived and
bearer-only, so writing it to the database would create a durable credential in
backups and audit exports for no benefit.

## 4. Configuration scope — why credentials are platform-level

M3 §2 defines:

- **Bridge ID** — the client id NHA issues to an *integrator* (`SBX_000135`)
- **Service ID** — the *facility* id from the NHPR/HFR (`IN02100000XX`)

One deployment holds one bridge and authenticates once; facilities are addressed
as services beneath it. So ABDM credentials live in the **process environment**,
not in a per-facility table. A facility-scoped credential would not merely be
redundant — it would let one facility's configuration authenticate as the entire
bridge.

Facility-level interoperability data (HFR/HPR service identifiers) is already
modelled as `ExternalIdentifier` rows and remains strictly facility-scoped.

## 5. Callback security

The callback endpoint is public by necessity — the CM has no Aarogya session.
It is therefore the most exposed surface in the system and is treated as hostile
input.

Four independent controls, in order:

1. **Authenticate** — deployment-configured shared secret, constant-time
   compare. No secret configured means callbacks are *refused*, never accepted
   unauthenticated.
2. **Bound the window** — `TIMESTAMP` must be within ±10 minutes.
3. **Correlate** — the callback must name a request *we started*, in a facility
   that owns it. An uncorrelated callback is recorded `UNMATCHED` and ignored.
4. **De-duplicate** — a unique `(facilityId, callbackKind, externalRequestId)`
   row. A replayed callback collides on insert instead of being processed twice.

Then: **derive, never accept.** Patient, facility and actor come from the
correlated exchange. Nothing in the callback body can nominate them.

Non-security outcomes answer `202` so the gateway is not encouraged to retry a
callback we deliberately ignored. Authentication failures answer a fixed `401`
that discloses nothing about why.

## 6. Retry safety

`abdm/errors.ts` classifies every failure and decides retryability from the
*class*, not the message:

- **Retryable** — `TIMEOUT`, `NETWORK_ERROR`, `EXTERNAL_SERVER_ERROR`, `RATE_LIMITED`
- **Never retried** — `VALIDATION_ERROR`, `AUTHORIZATION_ERROR`, `CONSENT_ERROR`,
  `IDENTITY_ERROR`, `CONFIGURATION_ERROR`, `AUTHENTICATION_ERROR`, `CONFLICT`,
  `NOT_FOUND`, `CALLBACK_ERROR`

Retrying a validation or consent failure unchanged cannot succeed, and for an
operation that partially applied remotely it could duplicate a disclosure.
Session refresh is the one exception: a single retry on `AUTHENTICATION_ERROR`,
because a stale token is genuinely transient — but a persistent 401 means bad
credentials and is not hammered.

## 7. Consent: local is not external

A local Aarogya consent row is **not** an ABDM consent artefact.

- Aarogya purposes are clinical intents; ABDM's are a fixed six-code vocabulary.
- Aarogya scopes are data categories (`LAB`); ABDM hiTypes are document classes
  (`DiagnosticReport`). Many-to-many, not a rename.
- An ABDM artefact is created by the **Consent Manager** after the *patient*
  approves it in their own ABHA app, and carries a CM-issued id.

`reconcileConsentStatus()` enforces the rule that matters: **the external view
wins when it is more restrictive, and an unknown external state blocks.** A
locally-`GRANTED` consent the CM reports as `REVOKED` must never authorise a
transfer just because the local row is stale.

## 8. Failure isolation

ABDM being unreachable cannot affect care. Structurally:

- every external call happens **outside** any clinical transaction
- the adapter is reached only from the exchange service, never from a clinical one
- the default configuration is `DISABLED`
- consent is re-checked **before** an exchange moves to `PROCESSING`, so a
  withdrawn consent fails the dispatch without ever entering a live state

With ABDM entirely down or switched off, admission, transfer, nursing,
medication administration, diagnostics, OT, blood bank, discharge and
documentation are unaffected. Only exchange stops.

## 9. Extension points

| To add | Touch only |
| --- | --- |
| A new ABDM endpoint | `abdm/contract.ts` + a caller |
| Real profile validation | `fhir/profiles.ts::validateFhirResource` |
| Callback signature verification | `abdm/callbacks.ts` |
| A different external network | implement `HealthInteroperabilityAdapter` |
| ECDH data push | new module under `abdm/`, parameters already pinned |

No mapper, clinical service or route needs to change for any of these.
