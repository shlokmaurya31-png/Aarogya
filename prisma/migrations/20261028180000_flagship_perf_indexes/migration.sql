-- Flagship 1c (performance pass): indexes for the reads the perf gate found
-- scanning whole tables on a year of a 200-bed hospital. Additive only: no
-- data is changed. On a large live table, build these CONCURRENTLY by hand
-- before deploying (CREATE INDEX blocks writes while it runs).

-- A patient's orders, newest first (the timeline and the chart).
CREATE INDEX "LabOrder_patientId_orderedAt_idx" ON "LabOrder"("patientId", "orderedAt");
CREATE INDEX "ImagingOrder_patientId_orderedAt_idx" ON "ImagingOrder"("patientId", "orderedAt");

-- Results awaiting verification (the diagnostics snapshot).
CREATE INDEX "LabResult_status_isCurrent_idx" ON "LabResult"("status", "isCurrent");

-- Unsigned notes, by author (the doctor workspace).
CREATE INDEX "ClinicalNote_status_authorStaffId_idx" ON "ClinicalNote"("status", "authorStaffId");
