# Hospital Command Center 2.0 (D10)

The Command Center is an **operational control surface** for hospital leadership and
authorized operational staff. Its defining principle: **every number answers "why?",
not just "how many?"**. It is a **read / intelligence layer** over canonical domain
truth — it is never the source of truth, and it performs no clinical/financial
mutation of its own.

```
D1 TENANCY → C4 AUTHORIZATION → DOMAIN SYSTEMS → D6 EVENTS → D7 WORKFLOW → D8 CONFIG
                                                                          ↓
                                              D10 COMMAND CENTER (read / intelligence)
```

## Architecture audit (what already existed, what D10 adds)

| Area | Existing | D10 decision |
|---|---|---|
| Command center snapshot | `src/lib/hospital/commandCenter.ts` (`getCommandCenterSnapshot`) — beds, flow, queues, safety, clinical-ops, diagnostics, alerts (facility-scoped live aggregates) | **Reuse the query patterns**; wrap every metric in a semantic contract (status/why/drivers/drill-down/asOf) and add the missing domains. Not replaced. |
| Alert engine | `alertEngine.ts` (`computeAlerts`) | **Reuse** as one input to the attention queue. |
| Diagnostics counts | `diagnosticsSnapshot.ts` | **Reuse** for lab/radiology sections. |
| Tenant scope | D1 `requireFacilityStaff` / `resolveFacilityForStaff` | **Reuse** — the server-side chokepoint; client facility/org/dept is never authoritative. |
| Authorization | C4 / RBAC permissions | **Reuse** — `hospital:command-center:view` (base), `billing:view` (finance), `quality:incident:read` (incidents), clinical perms for patient drill-down. |
| Thresholds | D8 configuration engine | **Reuse** — `commandCenter.{metric}.warning|.critical` config keys, tenant-aware, versioned. |
| Workflow state | D7 | **Reuse** read-only (overdue tasks / SLA); actions invoke existing D7 paths. |

## Canonical sources per domain

| Domain | Canonical source |
|---|---|
| Bed capacity | `Bed` (status, wardId, icuCapable), `Ward` |
| ED pressure | `Encounter` (type ED), `QueueEntry` (ED) |
| ICU capacity | `Bed` where `icuCapable` / `icuUnitId`, `IcuUnit`, `AdmissionRequest`/`TransferRequest` |
| OT | `Surgery` (status), `SurgerySchedule` (startAt/endAt), `OperatingTheatre` |
| Lab TAT | `LabOrder`/specimen/result lifecycle timestamps (via `diagnosticsSnapshot`) |
| Radiology TAT | imaging study/report lifecycle (via `diagnosticsSnapshot`) |
| Discharge bottlenecks | `Discharge` readiness flags (clinically/documentation/billing/insurance/pharmacy/transport) |
| Critical results | lab/imaging critical + acknowledgement (aggregate; PHI gated) |
| Staffing | `StaffShift`, `WorkforceAssignment`, `Task` backlog, `Encounter` census |
| Pharmacy | `MedicationOrder` (PHARMACY_REVIEW/HELD), `MedicationAdministration`, `StockBalance`/`StockReservation` |
| Revenue | **hospital revenue cycle** `Invoice` / `Payment` (patient billing) — DISTINCT from D3/D5 SaaS commercial billing |
| Claims | `Claim` (status, amounts, denialReason, timestamps) |
| Infection | `InfectionIncident` (status, type, isolation) |
| Incidents | `QualityIncident` (status, severity, category, confidentiality) |

> **Revenue note:** the hospital Command Center's revenue reflects the **patient
> revenue cycle** (`Invoice`/`Payment`), which is the hospital's operational money.
> This is deliberately distinct from the D3/D5 SaaS commercial layer (what an
> organization pays Aarogya). D10 does not conflate them and builds no new finance engine.

## Design guarantees

- **Read-only / non-authoritative.** No `CommandCenter*` authoritative state; no
  parallel clinical/financial truth. No new engine, event bus, config engine, or
  infrastructure.
- **Every KPI answers WHY** via deterministic drivers backed by canonical data
  (no AI, no fabricated causality; correlation is never labelled causation).
- **Error isolation.** A failed subsystem yields an explicit `UNAVAILABLE` state
  with a last-known `asOf` — never a misleading `0`.
- **Tenant isolation.** Facility/org/department scope is server-derived; cross-tenant
  access fails via D1.
- **Privacy.** Aggregate by default; patient-level drill-down requires clinical
  authorization; financial sections require `billing:view`.
- **Configurable interpretation, canonical computation.** D8 thresholds change only
  status interpretation, never the underlying number.
- **Bounded performance.** Independent reads run in parallel, DB-level aggregation,
  bounded time windows, paginated drill-downs, no N+1, no polling daemon.

See [metrics](COMMAND_CENTER_METRICS.md), [security](COMMAND_CENTER_SECURITY.md),
[performance](COMMAND_CENTER_PERFORMANCE.md).
