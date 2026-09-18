# SLA Configuration

D8 makes SLA policy configurable per hospital/facility/department; D7 (and other
consumers) apply it. This is distinct from the clinical `SlaPolicy` /
`hospital/sla.ts` metric thresholds, which D8 does not replace.

## Keys

- `sla.{name}` — a named operational SLA in seconds (e.g. `sla.critical_result_ack`,
  `sla.admission_assessment`), some with registry defaults.
- `workflow.{key}.sla` — a workflow-specific SLA (see [workflows](workflows.md)).
- `queue.{key}.max_wait` — a queue wait SLA (foundation).

Durations accept shorthand (`15m`, `4h`) and normalize to seconds; bounded ≤ 30 days.

## Who computes deadlines

D8 supplies the **policy** (the duration + provenance). The consuming domain computes
and **persists** the deadline once, at the moment work starts, and snapshots the
effective value — so the deadline is deterministic and historically explainable even
if the SLA policy later changes. D8 does not run timers or detect breaches; D7 does.

## Multi-hospital example (verified)

```
Org A: sla.critical_result_ack = 15m
Org B: sla.critical_result_ack = 60m
```

Same code, different effective SLA per organization — with department/facility
overrides taking precedence where set.
