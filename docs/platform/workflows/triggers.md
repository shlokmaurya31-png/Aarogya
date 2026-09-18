# Triggers

A workflow is triggered by a **D6 domain event**. The engine does not create a
second event system — it registers a single consumer (`workflow-engine`) with the
D6 dispatcher, so it inherits at-least-once + idempotent delivery.

## Trigger definition

```json
{ "trigger": { "eventType": "LabResultReleased", "eventVersion": 1,
               "condition": { "all": [{ "field": "payload.critical", "operator": "equals", "value": true }] } } }
```

- `eventType` + `eventVersion` must resolve to a known contract in the **D6 event
  catalogue** — unknown types/versions are rejected at publication.
- The optional `condition` is a safe declarative gate (see [conditions](conditions.md)):
  if present and false for a given event, **no instance is created**.

## Matching & idempotency

On each delivered event the engine finds `ACTIVE` definitions whose denormalized
`triggerEventType`/`triggerEventVersion` match, loads the published version, and
evaluates the trigger condition. Instance creation is idempotent on
`${definitionId}:${eventId}` (a unique key), so **a duplicate delivery of the same
event never creates a duplicate instance** (gate Race 1).

## Preserved lineage

Each instance records `triggerEventId`, `correlationId`, and `causationId` from the
event. When a workflow action emits a further domain event, that event carries the
instance's `correlationId` and names the trigger event as its cause — the causal
chain is preserved without a separate tracing model. See
[execution](execution.md#loop-prevention) for the correlation-chain depth cap that
prevents event→workflow→event loops.
