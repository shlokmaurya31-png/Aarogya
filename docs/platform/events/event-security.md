# Event Security & Privacy

## Events are not a data API and not a permission grant

An event referencing `patientId=123` does **not** authorize any consumer to read
that patient's record. Consumers must still use the existing tenant context, C4
authorization, consent, purpose, relationship and break-glass rules. Events carry
identifiers and minimal metadata, never the record contents.

## No client-created events

There is deliberately **no** `POST /events` endpoint. Clients issue domain commands;
trusted domain services emit events server-side. Clients can never select the event
type, tenant, aggregate, or payload, nor mark events processed, replay them, or
change their status.

## Tenant isolation

- Organization/facility events carry a **server-derived** `organizationId`
  (never client-supplied), resolved from the authenticated context / owning facility.
- Cross-tenant reads are denied: an organization admin reading another org's events
  gets a 404-shaped denial. A tenant sees only its own events, via the org-scoped
  route (`commercial:read` + D1 membership).
- Guessing an `eventId` never reveals another tenant's event — single-event
  inspection is platform-only.

## Platform-only operations

`platform:events:operate` (held only by `AAROGYA_ADMIN`) is required to read the
cross-tenant stream, metrics, dead letters, and to **replay** or retry. An
organization admin can never replay events.

## Data minimization

`sensitiveGuard.ts` rejects — at any depth — any payload key matching secrets, card
data, tokens, webhook/session/auth material, or free clinical text, and rejects
blob-length strings. This is a second barrier behind the catalogue's `.strict()`
schemas. Error messages surfaced to operators are truncated and never include
payloads or stack traces.

## Adversarial tests (see `scripts/verify-postgres-d6-events.ts`)

- Arbitrary event creation / sensitive keys → rejected on emit.
- Tenant/aggregate spoofing, cross-org inspection → denied.
- Replay by an org admin → denied.
- Payload/status mutation by clients → impossible (no surface).
- Consumer cannot use event metadata to bypass C4 (consumers touch only their own
  concern).
