# Configuration Audit & History

Two complementary records, both never containing secrets:

## AuditEvent (who did the act)

Administrative acts are recorded via the existing AuditEvent system in the
`configuration.` namespace:

- `configuration.set` — a draft was created/updated
- `configuration.published` — a draft was published (with version + effectiveFrom)
- `configuration.reset` — an override was reset (inherit again)
- `configuration.retired` — reserved for explicit retirement

Effective-value **lookups are never audited** (they are hot-path reads). This
preserves the separation: DomainEvent = what happened, AuditEvent = who did what,
ConfigurationChange = the value-level ledger.

## ConfigurationChange (what the value became)

An immutable, tenant-scoped ledger row per change: `action` (SET/PUBLISH/RESET/
RETIRE), `oldValue`, `newValue`, `version`, `actorUserId`, `reason`, `createdAt`,
`scope`, `scopeRef`, `key`, `organizationId`. This is what the admin UI / explainer
reads to show a key's history. Exposed via `GET …/configuration/history`.

## Safety

Values are validated and secret-scanned before persistence, so neither AuditEvent nor
ConfigurationChange can contain passwords, tokens, credentials, or PHI blobs.
