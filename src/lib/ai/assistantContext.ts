/**
 * The record context the portal assistant (/api/chat) may use. Built
 * server-side from data the caller is already authorized to read, never from
 * anything the client sends, and kept small: the model gets what a person
 * would glance at, not the whole chart.
 *
 *   patientAssistantContext   the patient (or a delegate) about the record in
 *                             scope, through the patient portal's own section
 *                             readers, so it sees exactly what the portal shows
 *                             and only the data classes the scope allows.
 *   clinicianAssistantContext one chart a staff member has already been
 *                             authorized for (facility + chart permission).
 */
import { assertClass, type PatientAccessScope } from "@/lib/patient/context";
import { safeSection, type SectionState } from "@/lib/patient/experience/section";
import { getProfile } from "@/lib/patient/experience/profile";
import { buildRecords } from "@/lib/patient/experience/records";
import { listMedications } from "@/lib/patient/experience/medications";
import { listAppointments } from "@/lib/patient/experience/appointments";
import { listReports } from "@/lib/patient/experience/reports";
import { billingSummary } from "@/lib/patient/experience/billing";
import { buildPatientSummary } from "@/lib/patient/summary";
import { ageInYears } from "@/lib/patient/age";

const day = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : "date unknown");

/** One section: its lines, "none" when empty, or why it isn't there. */
function section<T>(title: string, state: SectionState<T[]> | "not-shared", line: (t: T) => string, max = 8): string {
  if (state === "not-shared") return `${title}\n(not shared with this account)`;
  if (state.status !== "OK") return `${title}\n(temporarily unavailable — don't assume there is none)`;
  if (state.data.length === 0) return `${title}\nnone on record`;
  return `${title}\n${state.data.slice(0, max).map((t) => `- ${line(t)}`).join("\n")}`;
}

/** Reads a section only when the scope may read that data class. */
function inScope<T>(scope: PatientAccessScope, cls: Parameters<typeof assertClass>[1], read: () => Promise<T>): Promise<SectionState<T>> | "not-shared" {
  return scope.allowedClasses.has(cls) ? safeSection(read) : "not-shared";
}

export async function patientAssistantContext(scope: PatientAccessScope): Promise<string> {
  const profile = await inScope(scope, "PERSONAL", () => getProfile(scope));
  const records = await inScope(scope, "RECORDS", () => buildRecords(scope));
  const [meds, appts, reports, billing] = await Promise.all([
    inScope(scope, "MEDICATIONS", () => listMedications(scope)),
    inScope(scope, "APPOINTMENTS", () => listAppointments(scope)),
    inScope(scope, "REPORTS", () => listReports(scope)),
    inScope(scope, "BILLING", () => billingSummary(scope)),
  ]);

  const who =
    profile !== "not-shared" && profile.status === "OK"
      ? `${profile.data.preferredName ?? profile.data.fullName}${profile.data.bloodGroup ? `, blood group ${profile.data.bloodGroup}` : ""}`
      : "this patient";
  const viewer = scope.isSelf ? "The user is the patient." : "The user is a family member or caregiver with delegated access to this patient's record.";
  const rec = records === "not-shared" ? "not-shared" : records;
  const pick = <K extends "problems" | "allergies" | "visits">(k: K) =>
    rec === "not-shared" ? ("not-shared" as const) : rec.status === "OK" ? ({ status: "OK", data: rec.data[k] } as SectionState<(typeof rec.data)[K]>) : ({ status: "UNAVAILABLE" } as const);
  const upcoming = appts === "not-shared" ? appts : appts.status === "OK" ? { status: "OK" as const, data: appts.data.upcoming } : appts;
  const activeMeds = meds === "not-shared" ? meds : meds.status === "OK" ? { status: "OK" as const, data: meds.data.filter((m) => m.isActive) } : meds;
  const bill =
    billing === "not-shared"
      ? "BILLING\n(not shared with this account)"
      : billing.status === "OK"
        ? `BILLING\noutstanding ₹${Math.round(billing.data.outstandingMinor / 100)} across ${billing.data.invoiceCount} invoice(s)`
        : "BILLING\n(temporarily unavailable)";

  return [
    `PATIENT: ${who}. ${viewer}`,
    section("ALLERGIES", pick("allergies"), (a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ""}${a.severity ? `, ${a.severity}` : ""}`),
    section("PROBLEMS", pick("problems"), (p) => `${p.name}${p.since ? ` since ${day(p.since)}` : ""}`),
    section("ACTIVE MEDICINES", activeMeds, (m) => `${m.drug} ${m.dose}, ${m.frequency} (${m.statusLabel})`),
    section("UPCOMING APPOINTMENTS", upcoming, (a) => `${day(a.scheduledStart)} with ${a.doctorName}${a.department ? `, ${a.department}` : ""} (${a.statusLabel})`),
    section("RECENT VISITS", pick("visits"), (v) => `${day(v.date)}${v.department ? `, ${v.department}` : ""}: ${v.reason ?? v.statusLabel}`, 5),
    section("RELEASED REPORTS", reports, (r) => `${day(r.date)} ${r.title} (${r.kind.toLowerCase()})`, 5),
    bill,
  ].join("\n\n");
}

/** `facilityId`: the clinician's facility; patient uploads appear only under personAccess (Phase 0). */
export async function clinicianAssistantContext(patientId: string, facilityId: string): Promise<string> {
  const s = await buildPatientSummary(patientId, { kind: "STAFF", facilityId });
  if (!s.patient) return "No patient chart is open.";
  const p = s.patient;
  const age = ageInYears(p.dob);
  const ok = <T,>(data: T[]): SectionState<T[]> => ({ status: "OK", data });
  return [
    `CHART: ${p.fullName}, ${p.sex}${age !== null ? `, ${age}y` : ""}${p.bloodGroup ? `, ${p.bloodGroup}` : ""} (UHID ${p.uhid})`,
    section("ALLERGIES", ok(s.activeAllergies), (a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ""}, ${a.severity ?? "severity not recorded"}, ${a.verification.toLowerCase()}${a.source === "PATIENT_PROVIDED" ? ", patient-reported" : ""}`),
    section("ACTIVE PROBLEMS", ok(s.activeProblems), (pr) => `${pr.diagnosis}${pr.severity ? `, ${pr.severity}` : ""}${pr.onsetDate ? ` since ${day(pr.onsetDate)}` : ""}`),
    section("ACTIVE MEDICATIONS", ok(s.activeMedications), (m) => `${m.drugName} ${m.dose}, ${m.frequency} (${m.status})`),
    section("RECENT VITALS", ok(s.recentVitals), (v) =>
      [day(v.recordedAt), v.hr != null && `HR ${v.hr}`, v.sbp != null && `BP ${v.sbp}/${v.dbp ?? "?"}`, v.rr != null && `RR ${v.rr}`, v.spo2 != null && `SpO2 ${v.spo2}%`, v.tempC != null && `T ${v.tempC}°C`]
        .filter(Boolean)
        .join(", ")
    ),
    section("PENDING LAB ORDERS", ok(s.pendingLabOrders), (l) => `${l.testName} (${l.priority}, ${l.status}, ordered ${day(l.orderedAt)})`),
    section("PENDING IMAGING", ok(s.pendingImagingOrders), (i) => `${i.modality} ${i.studyDescription} (${i.priority}, ${i.status})`),
    section("ACTIVE CARE PLANS", ok(s.activeCarePlans), (c) => `${c.problem}: ${c.goal}`),
    section("RECENT ENCOUNTERS", ok(s.recentEncounters), (e) => `${day(e.registeredAt)} ${e.type} ${e.status}${e.department ? `, ${e.department.name}` : ""}`, 5),
    s.activeAdmission ? `CURRENT ADMISSION\nadmitted ${day(s.activeAdmission.admittedAt)}${s.currentLocation?.bed ? `, bed ${s.currentLocation.bed.label}` : ""}` : "CURRENT ADMISSION\nnot admitted",
  ].join("\n\n");
}
