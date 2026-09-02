/**
 * Phase 2 — Patient Flow / ADT demo data. Idempotency-guarded on
 * `Appointment.count()` (a brand-new table, so this is a safe first-run
 * marker). Attaches to the existing primary facility ("Aarogya Medical
 * Centre") and its existing staff/patients/beds from seedHospital() and
 * seedPhase1Extensions() — no duplicate users beyond the one genuinely new
 * persona (front desk) the brief's demo-personas section asks for.
 */
import { PrismaClient, Role, BedStatus } from "@prisma/client";
import { hashPassword } from "../../src/lib/auth/password";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function seedPhase2PatientFlow(prisma: PrismaClient) {
  const already = await prisma.appointment.count();
  if (already > 0) {
    console.log("Phase 2 patient-flow demo data already seeded — skipping.");
    return;
  }

  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const password = await hashPassword("Hospital@123");

  // ── Front desk persona (brief §66 — the one genuinely new role) ────────
  const frontDeskUser = await prisma.user.upsert({
    where: { email: "frontdesk@amc-demo.aarogya" },
    update: {},
    create: { email: "frontdesk@amc-demo.aarogya", displayName: "Kavya Reddy", role: Role.FRONT_DESK, passwordHash: password },
  });
  const frontDeskStaff = await prisma.hospitalStaffProfile.upsert({
    where: { userId: frontDeskUser.id },
    update: {},
    create: { userId: frontDeskUser.id, facilityId: facility.id, displayRole: "Front Desk Coordinator", status: "ACTIVE" },
  });

  const doctors = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facility.id, user: { role: "DOCTOR" } }, include: { user: true, department: true }, orderBy: { user: { displayName: "asc" } } });
  const nurses = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facility.id, user: { role: "NURSE" } }, take: 5 });
  const emergencyDoctor = doctors.find((d) => d.department?.name === "Emergency") ?? doctors[0];
  const opdDoctors = doctors.filter((d) => d.department?.name !== "Emergency").slice(0, 3);
  const patients = await prisma.patient.findMany({ where: { facilityId: facility.id }, take: 40, orderBy: { createdAt: "asc" } });
  const emergencyDept = await prisma.department.findFirst({ where: { facilityId: facility.id, name: "Emergency" } });

  // ── Doctor schedules: every day of week, so slot booking works regardless of when this seed runs ──
  for (const doc of opdDoctors) {
    for (let dow = 0; dow <= 6; dow++) {
      await prisma.doctorScheduleBlock.create({
        data: {
          staffId: doc.id, facilityId: facility.id, departmentId: doc.departmentId ?? undefined,
          type: "CLINIC_SESSION", dayOfWeek: dow, startMinute: 540, endMinute: 780, // 09:00-13:00
          slotDurationMinutes: 15, maxConcurrentAppointments: 1, roomLabel: `OPD-${doc.displayRole.slice(0, 4)}`,
        },
      });
    }
  }
  // One doctor has a leave day today, to prove LEAVE overrides a recurring session (brief §7).
  if (opdDoctors[0]) {
    await prisma.doctorScheduleBlock.create({
      data: { staffId: opdDoctors[0].id, facilityId: facility.id, type: "LEAVE", specificDate: startOfToday(), reason: "Annual leave" },
    });
  }

  // ── OPD Day scenario (brief §65): appointments across the full status range ──
  const today = startOfToday();
  const apptStatuses = ["REQUESTED", "CONFIRMED", "CHECKED_IN", "COMPLETED", "CANCELLED", "NO_SHOW"];
  let apptCount = 0;
  for (let i = 0; i < 18 && i + 5 < patients.length; i++) {
    const doctor = opdDoctors[1] ?? opdDoctors[0]; // a doctor WITHOUT the leave-day override above
    if (!doctor) break;
    const patient = patients[i + 5];
    const start = new Date(today.getTime() + (540 + i * 15) * 60_000);
    const end = new Date(start.getTime() + 15 * 60_000);
    const status = apptStatuses[i % apptStatuses.length];

    let encounterId: string | undefined;
    if (status === "CHECKED_IN" || status === "COMPLETED") {
      const encounter = await prisma.encounter.create({
        data: { patientId: patient.id, facilityId: facility.id, departmentId: doctor.departmentId ?? undefined, type: "OPD", accessSource: "APPOINTMENT", status: status === "COMPLETED" ? "DISCHARGED" : "REGISTERED", chiefComplaint: "Follow-up visit", attendingStaffId: doctor.id },
      });
      encounterId = encounter.id;
    }

    await prisma.appointment.create({
      data: {
        facilityId: facility.id, departmentId: doctor.departmentId ?? undefined, doctorStaffId: doctor.id, patientId: patient.id,
        type: i % 4 === 0 ? "FOLLOW_UP" : "NEW", source: "APPOINTMENT", scheduledStart: start, scheduledEnd: end,
        reason: "Routine consultation", status, encounterId,
        cancelledAt: status === "CANCELLED" ? new Date() : undefined, cancelledReason: status === "CANCELLED" ? "Patient requested reschedule" : undefined,
        noShowAt: status === "NO_SHOW" ? start : undefined,
        createdByStaffId: frontDeskStaff.id,
      },
    });
    apptCount++;

    if (status === "CHECKED_IN" && encounterId) {
      await prisma.queueEntry.create({
        data: { facilityId: facility.id, departmentId: doctor.departmentId ?? undefined, queueType: "OPD_DOCTOR", patientId: patient.id, encounterId, practitionerStaffId: doctor.id, priorityScore: 100, createdByStaffId: frontDeskStaff.id },
      });
    }
  }

  // A couple of walk-ins straight into the registration queue, no appointment (brief §45).
  for (let i = 0; i < 2 && i < patients.length; i++) {
    const patient = patients[i];
    const encounter = await prisma.encounter.create({
      data: { patientId: patient.id, facilityId: facility.id, type: "OPD", accessSource: "WALK_IN", status: "REGISTERED", chiefComplaint: "Walk-in — general check-up" },
    });
    await prisma.queueEntry.create({
      data: { facilityId: facility.id, queueType: "REGISTRATION", patientId: patient.id, encounterId: encounter.id, priorityScore: 100, createdByStaffId: frontDeskStaff.id },
    });
  }

  // ── ED surge scenario (brief §65): mixed triage levels, some pre-triage, one long-waiting for the SLA alert to fire ──
  const edAreas = ["RESUSCITATION", "HIGH_PRIORITY", "STANDARD", "OBSERVATION"];
  const edBeds = await prisma.bed.findMany({ where: { facilityId: facility.id, status: BedStatus.AVAILABLE, ward: { wardType: "EMERGENCY" } }, take: 4 });
  let edCount = 0;
  for (let i = 0; i < 10 && i + 20 < patients.length; i++) {
    const patient = patients[i + 20];
    const arrivalMode = i % 4 === 0 ? "AMBULANCE" : "WALK_IN";
    const registeredAt = i === 0 ? new Date(Date.now() - 90 * 60_000) : new Date(Date.now() - i * 4 * 60_000); // patient 0 waits 90 min — trips the ED_DOCTOR_WAIT SLA alert
    const encounter = await prisma.encounter.create({
      data: {
        patientId: patient.id, facilityId: facility.id, departmentId: emergencyDept?.id, type: "ED",
        accessSource: arrivalMode === "AMBULANCE" ? "AMBULANCE" : "EMERGENCY", arrivalMode, traumaIndicator: i === 2,
        ambulanceRef: arrivalMode === "AMBULANCE" ? `AMB-${100 + i}` : undefined,
        status: "REGISTERED", chiefComplaint: ["Chest pain", "Road traffic accident", "Severe abdominal pain", "Breathlessness", "Fall, head injury"][i % 5],
        registeredAt, attendingStaffId: i % 3 === 0 ? emergencyDoctor?.id : undefined,
      },
    });
    edCount++;

    const hasTriage = i < 7; // last 3 stay TRIAGE_PENDING, visible on the board
    if (hasTriage) {
      const acuity = 1 + (i % 5);
      const area = edAreas[Math.min(3, Math.floor((acuity - 1) / 1.25))];
      await prisma.triageAssessment.create({
        data: { encounterId: encounter.id, facilityId: facility.id, recordedByStaffId: nurses[i % nurses.length]?.id ?? nurses[0].id, acuity, assignedArea: area, chiefComplaint: encounter.chiefComplaint ?? undefined },
      });
      await prisma.encounter.update({ where: { id: encounter.id }, data: { triageLevel: acuity, status: "TRIAGED" } });

      if (edBeds[i % edBeds.length] && acuity <= 2) {
        await prisma.encounterLocation.create({
          data: { encounterId: encounter.id, facilityId: facility.id, bedId: edBeds[i % edBeds.length].id, assignedByStaffId: nurses[0]?.id },
        });
      } else if (area === "OBSERVATION") {
        await prisma.encounterLocation.create({ data: { encounterId: encounter.id, facilityId: facility.id, areaLabel: "Observation Bay" } });
      }
    }

    await prisma.queueEntry.create({
      data: {
        facilityId: facility.id, departmentId: emergencyDept?.id, queueType: "ED", patientId: patient.id, encounterId: encounter.id,
        practitionerStaffId: emergencyDoctor?.id, priorityScore: hasTriage ? (1 + (i % 5)) * 10 : 100,
        priorityReason: hasTriage ? `triage acuity ${1 + (i % 5)}` : "ED/emergency arrival", enteredAt: registeredAt,
      },
    });
  }

  // One ED patient in CT temporarily (brief §33 non-bed location example).
  if (patients[30]) {
    const ctEncounter = await prisma.encounter.findFirst({ where: { patientId: patients[30].id, type: "ED" } });
    if (ctEncounter) {
      await prisma.encounterLocation.create({ data: { encounterId: ctEncounter.id, facilityId: facility.id, areaLabel: "CT (temporary)" } });
    }
  }

  // ── Admission requests (brief §28-29): one pending, one bed-reserved ────
  const unadmittedEncounter = await prisma.encounter.findFirst({ where: { facilityId: facility.id, type: "ED", status: "TRIAGED" }, orderBy: { registeredAt: "asc" } });
  if (unadmittedEncounter && doctors[0]) {
    await prisma.admissionRequest.create({
      data: {
        patientId: unadmittedEncounter.patientId, encounterId: unadmittedEncounter.id, facilityId: facility.id,
        requestedByStaffId: emergencyDoctor?.id ?? doctors[0].id, requestedWardType: "GENERAL", priority: "URGENT",
        reason: "Requires inpatient management — unstable vitals in ED", expectedLosDays: 3,
      },
    });
  }

  const secondUnadmitted = await prisma.encounter.findMany({ where: { facilityId: facility.id, type: "ED", status: "TRIAGED" }, orderBy: { registeredAt: "asc" }, skip: 1, take: 1 });
  const generalBed = await prisma.bed.findFirst({ where: { facilityId: facility.id, status: BedStatus.AVAILABLE, ward: { wardType: "GENERAL" } } });
  if (secondUnadmitted[0] && generalBed && doctors[0]) {
    const req = await prisma.admissionRequest.create({
      data: {
        patientId: secondUnadmitted[0].patientId, encounterId: secondUnadmitted[0].id, facilityId: facility.id,
        requestedByStaffId: doctors[0].id, requestedWardType: "GENERAL", priority: "ROUTINE",
        reason: "Elective admission for further workup", status: "BED_RESERVED", reservedBedId: generalBed.id,
        reviewedByStaffId: doctors[0].id, reviewedAt: new Date(),
      },
    });
    await prisma.bed.update({ where: { id: generalBed.id }, data: { status: BedStatus.RESERVED } });
    await prisma.bedStateEvent.create({ data: { bedId: generalBed.id, fromStatus: BedStatus.AVAILABLE, toStatus: BedStatus.RESERVED, reason: `Admission request ${req.id}`, patientId: secondUnadmitted[0].patientId, encounterId: secondUnadmitted[0].id } });
  }

  // ── Transfer request (brief §34): one pending on an existing admitted patient ──
  const activeAdmission = await prisma.admission.findFirst({ where: { encounter: { facilityId: facility.id }, discharge: null } });
  if (activeAdmission && nurses[0]) {
    await prisma.transferRequest.create({
      data: {
        admissionId: activeAdmission.id, facilityId: facility.id, patientId: (await prisma.encounter.findUniqueOrThrow({ where: { id: activeAdmission.encounterId } })).patientId,
        requestedByStaffId: nurses[0].id, reason: "Requires closer monitoring — moving to a monitored bed", destinationWardType: "ICU", priority: "URGENT", transportRequired: true,
      },
    });
  }

  // ── SLA policy override (brief §52): a tighter ED wait threshold than the default, proven configurable ──
  await prisma.slaPolicy.create({ data: { facilityId: facility.id, metric: "ED_DOCTOR_WAIT", thresholdMinutes: 20 } });

  console.log("Seeded Phase 2 patient-flow demo data:");
  console.log(`  1 front-desk user, ${opdDoctors.length} doctor schedules (7 days each), ${apptCount} appointments, 2 walk-ins`);
  console.log(`  ${edCount} ED arrivals (mixed triage/pending), admission requests, 1 transfer request, 1 SLA override`);
  console.log("  Demo login (password Hospital@123): frontdesk@amc-demo.aarogya");
}
