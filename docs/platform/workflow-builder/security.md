# Security & Privacy

## Tenant isolation (§26/§39)
Authoring is tenant-scoped: `assertCanAuthorWorkflow` requires org administration of
the target organization; GLOBAL templates (organizationId null) stay platform-only.
Scope is server-derived — a client cannot author/read/publish another org's workflow
(verified: cross-org read/publish/list denied 404; guessed ids reveal nothing). An
org-scoped workflow also **executes** only for its own organization's events (D7
trigger filter).

## Authorization (§27)
Reuses C4: `workflow:read` (view), `workflow:manage` (author/version/publish/retire,
scoped), `workflow:operate` (execution ops, platform-only). The builder never grants
permissions and cannot edit roles/permissions.

## Injection / safety (§28)
Rejected at compile/publish: arbitrary actions, unknown events/versions, arbitrary
operators, malformed/oversized/deeply-nested definitions. No arbitrary function names,
API URLs, SQL, JavaScript, `eval`, shell, file/env/secret access, or DB-model refs.
SQL-injection values are inert (compared in memory, never queried). Prototype-pollution
keys are rejected by the sensitive guard + strict schemas.

## Privacy (§29)
Documents are secret/PHI-guarded on write (`sensitiveGuard`): passwords, tokens,
credentials, payment secrets, and blob-length clinical narratives are rejected at any
depth. Definitions store configuration, not patient records. Import lands as a DRAFT
and is fully revalidated; tenant scope is server-derived so an import cannot inject a
cross-tenant reference (§30). Export omits secrets.

## Privilege escalation (§39)
The action registry exposes no permission-granting or clinical/financial mutation
action, so a builder-authored workflow cannot bypass C4, consent, purpose, break-glass,
or step-up, nor invoke unauthorized clinical/financial mutations (verified).
