# Simulation

Simulation (`simulateWorkflow`, `POST …/workflow-builder/simulate`) is a **safe,
side-effect-free** dry run against a SYNTHETIC event (§23/§40). It:

- evaluates trigger matching + the trigger condition;
- walks the steps and reports which WOULD execute (or are gated/skipped);
- resolves the effective SLA via the D8 read-only resolver and shows its provenance;
- returns a clearly-labelled `SIMULATION` result.

It creates **no** tasks, timers, instances, or records; emits **no** domain events;
sends **no** notifications; and never touches clinical/billing/inventory/medication
state (verified in the gate: task/instance/event counts are unchanged, including under
concurrent simulations). It uses synthetic payloads only — never real patient data —
and does not replay production events (D6 replay stays a platform operation).
