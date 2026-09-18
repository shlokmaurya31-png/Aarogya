# Conditions

Conditions are **safe declarative data**, never code. There is no `eval`, no
arbitrary JavaScript, no arbitrary SQL, and no Turing-complete rules language.

## Grammar

- **Leaf:** `{ "field": "<path>", "operator": "<op>", "value": <literal|list> }`
- **Groups:** `{ "all": [...] }`, `{ "any": [...] }`, `{ "not": {...} }` (bounded nesting).

### Operator set (deliberately small)

`equals`, `not_equals`, `in`, `not_in`, `exists`, `not_exists`, `greater_than`,
`greater_than_or_equal`, `less_than`, `less_than_or_equal`, `contains`.

Numeric comparisons apply only to finite numbers; `in`/`not_in` compare against a
bounded list; `contains` works on strings and arrays.

## Allow-listed context

A condition can inspect ONLY:

```
event.type, event.version, event.aggregateType, event.aggregateId,
event.organizationId, event.facilityId, event.actor,
payload.<approved fields>
```

A `field` path **must** begin with `event.` or `payload.`. Any other root is
rejected at validation. The resolver walks only plain-object own keys and refuses
`__proto__` / `prototype` / `constructor` segments (no prototype pollution). A
condition cannot query arbitrary tables, read patient records, or reach secrets — if
a workflow needs more state, that must come through a server-side domain service
with normal authorization (a future action provider), never arbitrary ORM access.

## Safety against injection

Condition `value`s are compared **in memory** against the context; they are never
interpolated into SQL or any query. A value like `'; DROP TABLE ...` is inert data —
verified by the gate.

## Bounds

Enforced by `assertConditionBounds` at publication: max nesting depth (5) and max
node count (40). See [security](security.md).
