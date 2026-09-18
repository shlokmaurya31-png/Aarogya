# Rules, Escalation, Alerts, Queues & Forms (declarative only)

D8 uses **bounded, declarative** structures — never a rules programming language, no
arbitrary code/SQL/formulas, no `eval`.

## Escalation policy

`workflow.{key}.escalation` / `escalation.{name}` store a strict JSON policy:

```json
{ "steps": [
  { "afterSeconds": 1800, "notifyRole": "NURSE", "priority": "URGENT", "intent": "review" },
  { "afterSeconds": 3600, "notifyRole": "HOSPITAL_ADMIN", "priority": "STAT" }
] }
```

It defines **who / when / what intent / priority** — a safe action-provider seam.
Delivery (SMS/email/push) is a later Notifications phase and is **not** built here.
Bounded to ≤ 10 steps; unknown keys, secrets, and blobs are rejected.

## Alerts (foundation)

`alert.{key}.enabled` / `.severity` / `.cooldown` configure alert behavior. D8
configures; a future notification layer delivers.

## Queues (foundation)

`queue.{key}.default_priority` / `.max_wait` configure the existing queue primitive's
behavior. D8 adds no second queue implementation.

## Forms (foundation)

`form.{key}.definition` stores a strict declarative form (fields/labels/types/
required/order/options), validated by a Zod schema. There is **no** visual builder
and **no** executable validation code; server-side validation is never bypassed.

## Billing rules (parameters only)

`billing.{rule}.enabled` / `.param` toggle approved rules and supply bounded numeric
parameters. Canonical billing calculations stay deterministic and server-side in
Billing; D8 never executes a formula.

## Shared rule grammar

Where D8 needs conditional logic it reuses the **D7 condition engine** (bounded
`equals/in/greater_than/…` with `all/any/not`) rather than inventing a second rule
language. See `src/lib/workflows/conditions.ts`.
