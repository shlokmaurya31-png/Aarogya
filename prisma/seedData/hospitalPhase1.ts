/**
 * Phase 1 seed extensions: a second facility (the brief's own "Delhi
 * Hospital / Noida Hospital" example — real multi-facility tenancy, and
 * the fixture the tenant-isolation test in src/lib/patient/*.test.ts and
 * the manual security verification depend on), plus new Phase 1 entities
 * (Diagnosis/Task/Document/Consent/Referral/EpisodeOfCare/
 * DepartmentMembership) attached to the existing facility's patients so
 * the three demo scenarios (brief §51) are concretely walkable.
 */
import { PrismaClient, WardType, BedStatus, EncounterType, EncounterStatus, Role } from "@prisma/client";
import { hashPassword } from "../../src/lib/auth/password";

export async function seedPhase1Extensions(prisma: PrismaClient) {
  const alreadySeeded = await prisma.episodeOfCare.count();
  if (alreadySeeded > 0) {
    console.log("Phase 1 clinical-core extensions already seeded — skipping.");
    return;
  }

  const primaryFacility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });

  // ── Second facility: "Aarogya Noida Hospital", same organization ───────
  const org = await prisma.organization.findFirstOrThrow({ where: { name: "Aarogya Health Network" } });
  const noida = await prisma.facility.upsert({
    where: { id: "fac-amc-noida" },
    update: {},
    create: { id: "fac-amc-noida", name: "Aarogya Noida Hospital", city: "Noida", organizationId: org.id },
  });

  const noidaDeptDefs = [
    { name: "Orthopedics", code: "ORTHO" },
    { name: "General Surgery", code: "SURG" },
    { name: "Pediatrics", code: "PEDS" },
  ];
  const noidaDepts = new Map<string, string>();
  for (const d of noidaDeptDefs) {
    const dept = await prisma.department.upsert({
      where: { facilityId_name: { facilityId: noida.id, name: d.name } },
      update: {},
      create: { facilityId: noida.id, name: d.name, code: d.code },
    });
    noidaDepts.set(d.name, dept.id);
  }

  const noidaWard = await prisma.ward.upsert({
    where: { facilityId_name: { facilityId: noida.id, name: "General Ward" } },
    update: {},
    create: { facilityId: noida.id, name: "General Ward", wardType: WardType.GENERAL, departmentId: noidaDepts.get("General Surgery") },
  });
  const noidaBeds = [];
  for (let i = 1; i <= 10; i++) {
    const bed = await prisma.bed.upsert({
      where: { facilityId_label: { facilityId: noida.id, label: `NGW-${i}` } },
      update: {},
      create: { facilityId: noida.id, wardId: noidaWard.id, label: `NGW-${i}` },
    });
    noidaBeds.push(bed);
  }

  const password = await hashPassword("Hospital@123");
  const noidaDoctorUser = await prisma.user.upsert({
    where: { email: "doctor1@noida-demo.aarogya" },
    update: {},
    create: { email: "doctor1@noida-demo.aarogya", displayName: "Dr. Alok Verma", role: Role.DOCTOR, passwordHash: password },
  });
  const noidaDoctorStaff = await prisma.hospitalStaffProfile.upsert({
    where: { userId: noidaDoctorUser.id },
    update: {},
    create: { userId: noidaDoctorUser.id, facilityId: noida.id, departmentId: noidaDepts.get("Orthopedics"), displayRole: "Orthopedic Surgeon", status: "ACTIVE" },
  });
  const noidaAdminUser = await prisma.user.upsert({
    where: { email: "admin@noida-demo.aarogya" },
    update: {},
    create: { email: "admin@noida-demo.aarogya", displayName: "Aarogya Noida Hospital Admin", role: Role.HOSPITAL_ADMIN, passwordHash: password },
  });
  await prisma.hospitalStaffProfile.upsert({
    where: { userId: noidaAdminUser.id },
    update: {},
    create: { userId: noidaAdminUser.id, facilityId: noida.id, displayRole: "Hospital Administrator", status: "ACTIVE" },
  });

  const noidaPatientNames = [
    "Vikas Oberoi", "Rina Chawla", "Sameer Kapoor", "Tanvi Malhotra", "Arun Bhargava",
    "Kavita Saxena", "Deepesh Rana", "Nisha Kohli", "Manav Chopra", "Swati Agnihotri",
    "Rajat Bhalla", "Preeti Handa", "Yash Tandon", "Simran Dutta", "Gaurav Mehra",
    "Alka Bakshi", "Nikhil Suri", "Ritika Grover", "Varun Sabharwal", "Payal Anand",
  ];
  const noidaPatients = [];
  for (let i = 0; i < noidaPatientNames.length; i++) {
    const uhid = `UHID-NOIDA-${String(2000 + i)}`;
    const patient = await prisma.patient.upsert({
      where: { uhid },
      update: {},
      create: {
        uhid,
        facilityId: noida.id,
        fullName: noidaPatientNames[i],
        sex: i % 2 === 0 ? "male" : "female",
        ageYears: 20 + (i * 6),
        phone: `+91 97${String(300000 + i * 41).padStart(6, "0")}`,
      },
    });
    noidaPatients.push(patient);
  }

  // A couple of encounters + one admission at the second facility, so tenant-isolation tests have real data to try (and fail) to cross-read.
  for (let i = 0; i < noidaPatients.length; i++) {
    const p = noidaPatients[i];
    const encounter = await prisma.encounter.create({
      data: {
        patientId: p.id, facilityId: noida.id, departmentId: noidaDepts.get("Orthopedics"),
        type: i === 0 ? EncounterType.IPD : EncounterType.OPD,
        status: i === 0 ? EncounterStatus.ADMITTED : EncounterStatus.REGISTERED,
        chiefComplaint: i === 0 ? "Fracture, right femur" : "Joint pain",
        attendingStaffId: noidaDoctorStaff.id,
      },
    });
    if (i === 0) {
      const bed = noidaBeds[0];
      await prisma.bed.update({ where: { id: bed.id }, data: { status: BedStatus.OCCUPIED } });
      await prisma.bedStateEvent.create({
        data: { bedId: bed.id, fromStatus: BedStatus.AVAILABLE, toStatus: BedStatus.OCCUPIED, reason: "Admission: fracture fixation", patientId: p.id, encounterId: encounter.id },
      });
      await prisma.admission.create({
        data: { encounterId: encounter.id, bedId: bed.id, admittingStaffId: noidaDoctorStaff.id, reason: "Fracture, right femur — ORIF planned" },
      });
    }
  }

  console.log("Seeded second facility: Aarogya Noida Hospital");
  console.log(`  ${noidaDeptDefs.length} departments, 1 ward, ${noidaBeds.length} beds, 1 doctor, 1 admin, ${noidaPatients.length} patients`);
  console.log("  Demo logins (password Hospital@123): admin@noida-demo.aarogya, doctor1@noida-demo.aarogya");

  // ── Phase 1 clinical-core entities attached to the FIRST facility's existing patients ──
  const patients = await prisma.patient.findMany({ where: { facilityId: primaryFacility.id }, take: 15, orderBy: { createdAt: "asc" } });
  const doctors = await prisma.hospitalStaffProfile.findMany({ where: { facility: { id: primaryFacility.id }, user: { role: "DOCTOR" } } });
  const nurses = await prisma.hospitalStaffProfile.findMany({ where: { facility: { id: primaryFacility.id }, user: { role: "NURSE" } } });
  const encounters = await prisma.encounter.findMany({ where: { patientId: { in: patients.map((p) => p.id) } } });
  const departments = await prisma.department.findMany({ where: { facilityId: primaryFacility.id } });

  function pick<T>(arr: T[], i: number): T { return arr[i % arr.length]; }
  function encounterFor(patientId: string) { return encounters.find((e) => e.patientId === patientId); }

  // Demo Scenario A (OPD): patient[1] — registered -> vitals -> diagnosis -> note -> order -> completed. (vitals/note/order already exist from base seed for many; add the diagnosis here.)
  const scenarioA = patients[1];
  const scenarioAEncounter = encounterFor(scenarioA.id);
  if (scenarioAEncounter) {
    await prisma.diagnosis.create({
      data: {
        patientId: scenarioA.id, encounterId: scenarioAEncounter.id, diagnosis: "Essential hypertension",
        type: "PRIMARY", diagnosedByStaffId: pick(doctors, 1).id, onsetDate: new Date(Date.now() - 30 * 86_400_000),
      },
    });
    await prisma.problem.create({ data: { patientId: scenarioA.id, diagnosis: "Essential hypertension", status: "active", severity: "moderate" } });
  }

  // Demo Scenario B (inpatient): find an admitted patient, add problem + diagnosis + task.
  const admittedEncounter = encounters.find((e) => e.status === "ADMITTED");
  if (admittedEncounter) {
    await prisma.diagnosis.create({
      data: {
        patientId: admittedEncounter.patientId, encounterId: admittedEncounter.id, diagnosis: "Community-acquired pneumonia",
        type: "PRIMARY", diagnosedByStaffId: pick(doctors, 2).id,
      },
    });
    await prisma.task.create({
      data: {
        facilityId: primaryFacility.id, title: "Prepare discharge summary", type: "DISCHARGE_PREP", priority: "ROUTINE",
        status: "OPEN", dueAt: new Date(Date.now() + 2 * 3_600_000), source: "manual",
        patientId: admittedEncounter.patientId, encounterId: admittedEncounter.id,
        createdByStaffId: pick(doctors, 2).id, ownerStaffId: pick(nurses, 0).id,
      },
    });
  }

  // Demo Scenario C (complex patient): patient[2] gets multiple diagnoses, an allergy, an episode of care, a referral, a document, a consent.
  const scenarioC = patients[2];
  const scenarioCEncounter = encounterFor(scenarioC.id);
  const episode = await prisma.episodeOfCare.create({
    data: {
      patientId: scenarioC.id, facilityId: primaryFacility.id, title: "Type 2 diabetes management",
      type: "CHRONIC_DISEASE", reason: "Ongoing glycemic control and complication screening",
    },
  });
  if (scenarioCEncounter) {
    await prisma.encounter.update({ where: { id: scenarioCEncounter.id }, data: { episodeOfCareId: episode.id } });
    await prisma.diagnosis.createMany({
      data: [
        { patientId: scenarioC.id, encounterId: scenarioCEncounter.id, diagnosis: "Type 2 diabetes mellitus", type: "PRIMARY", diagnosedByStaffId: pick(doctors, 3).id },
        { patientId: scenarioC.id, encounterId: scenarioCEncounter.id, diagnosis: "Diabetic nephropathy, early stage", type: "SECONDARY", diagnosedByStaffId: pick(doctors, 3).id },
      ],
    });
    await prisma.referral.create({
      data: {
        patientId: scenarioC.id, encounterId: scenarioCEncounter.id,
        fromDepartmentId: departments.find((d) => d.name === "General Medicine")?.id,
        toDepartmentId: departments.find((d) => d.name === "Cardiology")?.id,
        fromStaffId: pick(doctors, 3).id, reason: "Cardiology review for diabetic cardiovascular risk assessment",
        priority: "ROUTINE", status: "PLACED",
      },
    });
  }
  await prisma.clinicalDocument.create({
    data: {
      facilityId: primaryFacility.id, patientId: scenarioC.id, encounterId: scenarioCEncounter?.id,
      type: "REPORT", title: "HbA1c trend report — endocrinology", accessPolicy: "CLINICAL_STAFF",
      authorStaffId: pick(doctors, 3).id, uploadedByStaffId: pick(doctors, 3).id,
    },
  });
  await prisma.consent.create({
    data: { patientId: scenarioC.id, purpose: "TREATMENT", scope: "Chronic disease management program", status: "GRANTED", grantedAt: new Date(), actorStaffId: pick(doctors, 3).id },
  });

  // Department membership example (brief §5: "Dr. Sharma: Cardiology + Emergency").
  const cardiologyDept = departments.find((d) => d.name === "Cardiology");
  const emergencyDept = departments.find((d) => d.name === "Emergency");
  const cardiologist = doctors.find((d) => d.displayRole === "Cardiology");
  if (cardiologyDept && emergencyDept && cardiologist) {
    await prisma.departmentMembership.upsert({
      where: { staffId_departmentId: { staffId: cardiologist.id, departmentId: emergencyDept.id } },
      update: {},
      create: { staffId: cardiologist.id, departmentId: emergencyDept.id },
    });
  }

  // Duplicate-detection demonstration: register a near-duplicate of an existing patient (same name pattern, different id) so /api/hospital/patients/duplicates has a real candidate to find.
  const dupSource = patients[0];
  await prisma.patient.upsert({
    where: { uhid: "UHID-AMC-DUP1" },
    update: {},
    create: {
      uhid: "UHID-AMC-DUP1", facilityId: primaryFacility.id, fullName: dupSource.fullName,
      sex: dupSource.sex, phone: dupSource.phone ?? undefined, ageYears: dupSource.ageYears,
    },
  });

  console.log("Seeded Phase 1 clinical-core entities: episode of care, diagnoses, task, referral, document, consent, department membership, a duplicate-detection fixture.");
}
