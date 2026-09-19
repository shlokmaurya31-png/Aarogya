# Command Center — Performance (D10)

The Command Center potentially touches many domains, so it is engineered to stay
bounded. No new infrastructure (no Redis/Kafka/warehouse/microservice) is introduced.

## Aggregation strategy
- **Parallel, bounded reads.** Each section runs its independent queries with
  `Promise.all`; the orchestrator runs all authorized sections in parallel with
  per-section error isolation.
- **DB-level aggregation.** Counts use `count`/`groupBy`/`aggregate` — never
  `findMany(...).length` for magnitudes. No entire patient/bed tables are loaded for
  aggregate metrics.
- **Bounded scans for derived metrics.** Lab/radiology TAT read a bounded sample
  (≤500 recent current results in the window) rather than the full history; drill-downs
  are capped at 50 rows.
- **Bounded time windows.** Every metric uses an explicit window; custom ranges are
  capped at 400 days.
- **No N+1.** Relation-scoped counts use nested `where` (e.g. `labOrder.encounter.facilityId`)
  resolved in a single query per metric, not per-row lookups.

## Indexes relied upon
Existing indexes cover the hot filters: `Bed(facilityId,status)`, `Encounter(facilityId,type,status)`,
`QueueEntry(facilityId,queueType,status)`, `LabResult(isCurrent,...)`/`isCritical`,
`ImagingReport(isCurrent)`, `Invoice(facilityId,status)`, `Claim(facilityId,status)`,
`InfectionIncident(facilityId)`, `QualityIncident(facilityId,status)`. No new index was
required for D10.

## Refresh model
- Manual/window-driven refresh only — **no aggressive polling and no daemon**. The
  Command Center is correct even when real-time event propagation is unavailable
  (it reads canonical state on demand). D8 threshold reads use the D8 in-process cache
  with per-org invalidation.

## Freshness
Each section and the overview carry `asOf`. Derived (TAT) metrics document the sample
window; state metrics are point-in-time as of the request. Real-time accuracy is never
implied.

## Deferred
Read-model materialization/caching is deliberately NOT introduced — profiling has not
shown a need at current scale, and adding a "cache" that could silently become
authoritative is explicitly avoided. If added later it must be derived, rebuildable,
tenant-scoped, and reconcilable.
