# Event Versioning

Events are **contracts**. The meaning of an existing version must never silently
change.

## Rules

- Every event carries an explicit `eventVersion`.
- To change a payload's meaning materially, **add a new version** (`PatientRegistered`
  v2) and keep v1 in the catalogue. Do not mutate v1's schema.
- The catalogue is keyed by `${type}@${version}`. `currentVersion(type)` returns the
  latest declared version; `getEventContract(type, version)` resolves an exact
  contract or `undefined`.
- Emission without an explicit version uses the current version for that type.
- An unknown type or version is rejected **permanently** on emit (`UNKNOWN_TYPE` /
  `UNKNOWN_VERSION`) and dead-lettered if encountered at dispatch (`SCHEMA_UNKNOWN`).

## Compatibility policy

- **Additive, backward-compatible** payload changes (new optional field) may extend
  a version's schema only if every existing consumer still parses correctly. When in
  doubt, cut a new version.
- Consumers should understand the version(s) they declare and ignore or defer
  unknown ones rather than guessing.
- Event version is **not** the database migration version; they evolve
  independently.

## Immutable vs operational

Versioning protects the immutable business fields (`eventType`, `eventVersion`,
`aggregate*`, `organizationId`, `payload`, `occurredAt`). Operational fields
(`status`, `attemptCount`, `processedAt`, error info) always change during
processing and are not part of the contract.
