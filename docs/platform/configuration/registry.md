# Configuration Registry

The registry (`src/lib/config/registry.ts`) is the **closed set of legal keys**.
Arbitrary keys are refused on write. Each key has a value type, the scopes it may be
set at, an optional system default, a strict validator, and a canonicalizer.

## Value types (§7)

`BOOLEAN` · `NUMBER` · `STRING` · `ENUM` · `DURATION` · `JSON`. JSON is used only
where structured config genuinely requires it, and always has a strict Zod schema.
No type stores executable content.

- **DURATION** accepts shorthand (`30`, `30s`, `15m`, `4h`, `1d`) and is normalized
  to integer **seconds** for storage; bounded to ≤ 30 days.
- **JSON** is bounded (≤ 8 KB, depth ≤ 6, arrays ≤ 100) and passes the D6 sensitive
  guard (no secrets/PHI/blobs at any depth).

## Keys

### Exact keys (with a system default)

| Key | Type | Default |
|---|---|---|
| `sla.critical_result_ack` | DURATION | 15m |
| `sla.admission_assessment` | DURATION | 60m |
| `queue.triage.max_wait` | DURATION | 30m |
| `billing.auto_write_off.enabled` | BOOLEAN | false |

### Templated families (dynamic slug segment)

| Pattern | Type | Notes |
|---|---|---|
| `workflow.{key}.enabled` | BOOLEAN | default true |
| `workflow.{key}.sla` | DURATION | no default → falls back to the D7 version's own SLA |
| `workflow.{key}.priority` | ENUM(ROUTINE/URGENT/STAT) | |
| `workflow.{key}.escalation` | JSON | declarative escalation policy |
| `sla.{name}` | DURATION | named operational SLA |
| `escalation.{name}` | JSON | named escalation policy |
| `alert.{key}.enabled` / `.severity` / `.cooldown` | BOOLEAN/ENUM/DURATION | alert foundation |
| `queue.{key}.default_priority` / `.max_wait` | ENUM/DURATION | queue foundation |
| `billing.{rule}.enabled` / `.param` | BOOLEAN/NUMBER | bounded rule params, never a formula |
| `tariff.{code}.override_minor` | NUMBER | facility tariff override; calc stays in Billing |
| `package.{code}.enabled` | BOOLEAN | package availability |
| `form.{key}.definition` | JSON | strict declarative form definition |
| `department.{key}.param` | NUMBER | dept operational parameter |
| `role.{key}.responsible` | STRING | role mapping (final authz stays with C4) |

The dynamic segment is a bounded slug (`[a-z0-9][a-z0-9_.-]{0,80}`). `role.*` and
`billing.*` keys never carry authorization or executable logic — see
[security](security.md).

## Adding a key

Add one exact entry or one template to the registry. Unknown keys stay refused; the
UI reads the registry to know what is configurable.
