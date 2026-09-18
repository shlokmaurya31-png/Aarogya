# Migration & Relationship to D1 Config

## Schema changes (additive)

D8 adds two tables — `ConfigurationOverride` (the governed store) and
`ConfigurationChange` (immutable history) — in both migration trees
(`20260920090000_phase_d8_configuration_engine`). No existing table is changed; no
data is migrated or destroyed. Status/type fields are TEXT (D5/D6 convention), so the
SQLite and PostgreSQL trees are identical and there is **zero schema drift**
(`prisma migrate diff --exit-code` → No difference).

Verified: fresh PostgreSQL migration from zero, SQLite migration, replay, drift
check.

## Relationship to the D1 KV config

The pre-existing D1 `OrgConfigValue` / `FacilityConfigValue` / `DepartmentConfigValue`
tables and `src/lib/enterprise/configuration.ts` are a minimal untyped hierarchical
KV (a handful of keys, string defaults, delete-to-reset). They are **left intact**
and continue serving their existing keys.

D8 is a governed **superset**, not a replacement: it adds a strict typed registry,
scope inheritance with provenance, effective-date scheduling, versioning + a
publication boundary, immutable history, and snapshots. New operationally-significant,
typed, versioned, or effective-dated configuration goes through D8. The two systems
do not share tables, so neither interferes with the other; a future consolidation (if
desired) can migrate the D1 keys into the D8 registry additively.

## Future Workflow Builder seam (§48)

D8 provides validation, versioning, publication, scope, permissions, and provenance.
A later Workflow Builder generates validated workflow definitions/configuration that
D7 executes — it will sit on top of D8, not require rewriting the resolver or engine.
