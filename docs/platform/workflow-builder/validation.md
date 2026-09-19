# Validation

Validation is layered and the **backend is authoritative** (§17/§18):

1. **Document parse** (`parseBuilderDocument`) — coarse structure, size bound (64 KB),
   and secret/PHI guard (D6 `sensitiveGuard`, at any depth).
2. **Compile** (`compileBuilderDocument`) — requires a trigger + ≥1 step, assembles the
   canonical `{ trigger, steps }`, then runs the **D7 validator**
   (`validateWorkflowConfig`): unknown trigger event/version, unknown/non-invokable
   action, unknown operator, malformed graph, bad durations, over-nesting, excess
   nodes — all rejected.
3. **Structured report** (`buildValidationReport`) — for the UI: per-section pass/fail
   (trigger, condition, steps, SLA, security) plus errors. Advisory in the browser;
   the same compile runs server-side before any save-that-publishes.

An incomplete draft is intentionally "invalid to publish" but still saveable (§19).
Publication (`publishDraft`) re-compiles and drives the D7 lifecycle — the client can
never create a trusted published workflow directly.
