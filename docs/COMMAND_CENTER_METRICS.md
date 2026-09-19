# Command Center — Metric Catalogue (D10)

Every metric answers: WHAT? · SOURCE? · FORMULA? · TIME WINDOW? · WHY? · DRILL-DOWN? ·
AUTHORIZATION? · FRESHNESS? Values are canonical; only STATUS interpretation is
D8-configurable (`commandCenter.<metric>.warning|.critical`). A failed subsystem is
reported as `UNAVAILABLE`, never `0`. `asOf` is stamped on the overview and every
section.

| Section (auth) | Metric | Source | Formula | Time | WHY drivers | Drill-down |
|---|---|---|---|---|---|---|
| Bed capacity (`command-center:view`) | Bed occupancy % | `Bed` | (total−available)/total | current | admissions today, discharges today, blocked, discharge-ready waiting, transfers, admit requests | ward-occupancy |
| | Beds available / blocked | `Bed` | count by status | current | | blocked-beds |
| ED pressure (`command-center:view`) | Waiting, longest wait | `QueueEntry` (ED) | count; now−oldest enteredAt | current | arrivals, disposition pending, beds available | ed-queue |
| | Census, arrivals | `Encounter` (ED) | count; count in window | current / period | | |
| ICU capacity (`command-center:view`) | ICU occupancy % | `Bed` (icuCapable/icuUnitId) | (total−available)/total | current | occupied, blocked, facility transfers/admit requests (contributing) | icu-beds |
| OT (`command-center:view`) | Scheduled/in-progress/delayed | `Surgery`, `SurgerySchedule` | status counts; scheduled-start-passed | current | delayed, cancellations; utilization = UNAVAILABLE (hours not modelled) | ot-delayed |
| Lab TAT (`command-center:view`) | Avg/median/breaches | `LabResult`/`LabOrder` | **order-to-result** = resultedAt−orderedAt (bounded sample ≤500) | period | pending collection/verification, breaches, critical pending | lab-breaches |
| Radiology TAT (`command-center:view`) | Avg/median/breaches | `ImagingReport`/`ImagingOrder` | **order-to-report** = reportedAt−orderedAt | period | pending scheduling/verification, breaches, critical | radiology-breaches |
| Discharge bottlenecks (`command-center:view`) | Blocked, oldest | `Discharge` flags | clinicallyReady && any readiness flag false | current | Billing / Insurance / Pharmacy / Documentation / Transport (owners) | discharge-blockers |
| Critical results (`command-center:view`) | Pending, overdue (>1h), oldest | `LabResult`/`ImagingReport` (isCritical, acknowledgedAt) | count; count older than 1h | current | lab vs imaging pending, overdue (AGGREGATE ONLY — no PHI) | — |
| Staffing (`command-center:view`) | On-shift, coverage gaps, task backlog, unassigned admitted | `StaffShift`, `Task`, `Encounter`, `WorkforceAssignment` | active-now; cancelled today; overdue tasks; admitted w/o nursing assignment | current | cancelled shifts, overdue tasks, unassigned; ratio = UNAVAILABLE | — |
| Pharmacy (`command-center:view`) | Verification backlog, urgent, missed admin, stock-outs | `MedicationOrder`, `MedicationAdministration`, `StockBalance` | status counts; onHandQty≤0 | current | pending, urgent, held, missed, stock-outs | — |
| Revenue (`billing:view`) | Billed/collected today, outstanding | `Invoice`, `Payment` (patient revenue cycle) | Σ totals issued today; Σ payments today; Σ(total−allocated) | period / current | open invoices, unallocated payments | open-invoices |
| Claims (`billing:view`) | Exceptions, pending, settlement pending, aging | `Claim` | status counts; now−oldest submitted | current | denied, partial, settlement pending, aging | claims-denied |
| Infection (`command-center:view`) | Active, isolation, action-required, open investigations | `InfectionIncident`, `InfectionInvestigation` | status counts | current | action required, isolation, by type | — |
| Incidents (`quality:incident:read`) | High-severity open, open, overdue investigations | `QualityIncident` | status/severity counts; investigating >7d | current | high-severity, overdue, action-required, by category (AGGREGATE) | — |

## TAT definitions (explicit)
- **Lab TAT** = `LabResult.resultedAt − LabOrder.orderedAt` (order-to-result). Averaged
  over a bounded sample (≤500 current results) in the selected window. Never mixed with
  collection-to-result.
- **Radiology TAT** = `ImagingReport.reportedAt − ImagingOrder.orderedAt` (order-to-report).

## Revenue clarification
Revenue reflects the **patient revenue cycle** (`Invoice`/`Payment`), distinct from the
D3/D5 SaaS commercial layer. Amounts are INR minor units summed only within one currency
and presented in whole INR. A run-rate is never called "revenue".
