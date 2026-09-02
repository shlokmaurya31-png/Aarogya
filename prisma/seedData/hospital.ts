/**
 * Seeds a realistic (if intentionally scaled-down — see
 * docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md) demo hospital: "Aarogya Medical
 * Centre". Volumes are smaller than the brief's "100+ beds / 100+ patients"
 * ask — this seeds ~40 beds / ~30 patients with real structural variety
 * (mixed encounter types/statuses, some blocked/cleaning beds, a critical
 * unacknowledged lab result, a stalled discharge) so the Command Center has
 * genuine, non-trivial data to compute from, rather than a wall of
 * identical rows. Scaling the loop bounds up is a one-line change when more
 * volume is wanted.
 */
import { PrismaClient, Role, WardType, BedStatus, EncounterType, EncounterStatus } from "@prisma/client";
import { hashPassword } from "../../src/lib/auth/password";

const DOCTOR_NAMES = [
  { name: "Dr. Nikhil Bhatt", specialty: "Cardiology" },
  { name: "Dr. Priya Menon", specialty: "Orthopedics" },
  { name: "Dr. Farhan Sheikh", specialty: "General Medicine" },
  { name: "Dr. Kavita Deshmukh", specialty: "Pediatrics" },
  { name: "Dr. Ananya Iyer", specialty: "Emergency Medicine" },
  { name: "Dr. Rohan Kulkarni", specialty: "Neurology" },
  { name: "Dr. Meera Kapoor", specialty: "General Surgery" },
  { name: "Dr. Vikram Rao", specialty: "Obstetrics & Gynecology" },
];

const NURSE_NAMES = [
  "Sunita Pillai", "Ramesh Yadav", "Ayesha Khan", "Divya Iyer", "Suresh Naik",
  "Pooja Nair", "Arjun Reddy", "Kavya Menon", "Rahul Verma", "Neha Joshi",
];

const PATIENT_NAMES: { name: string; sex: string }[] = [
  { name: "Rohit Kadam", sex: "male" }, { name: "Sneha Kulkarni", sex: "female" },
  { name: "Arvind Rao", sex: "male" }, { name: "Farheen Ansari", sex: "female" },
  { name: "Manoj Tiwari", sex: "male" }, { name: "Ila Bhatt", sex: "female" },
  { name: "Deepak Chauhan", sex: "male" }, { name: "Lakshmi Narayan", sex: "female" },
  { name: "Sanjay Gupta", sex: "male" }, { name: "Ritu Sharma", sex: "female" },
  { name: "Imran Sheikh", sex: "male" }, { name: "Anjali Desai", sex: "female" },
  { name: "Karthik Subramaniam", sex: "male" }, { name: "Fatima Sayed", sex: "female" },
  { name: "Vikas Malhotra", sex: "male" }, { name: "Priyanka Singh", sex: "female" },
  { name: "Aditya Kumar", sex: "male" }, { name: "Meenal Joshi", sex: "female" },
  { name: "Rajesh Pillai", sex: "male" }, { name: "Sunita Reddy", sex: "female" },
  { name: "Amit Patel", sex: "male" }, { name: "Nandini Rao", sex: "female" },
  { name: "Faisal Khan", sex: "male" }, { name: "Geeta Iyer", sex: "female" },
  { name: "Harish Nair", sex: "male" }, { name: "Shalini Menon", sex: "female" },
  { name: "Ravi Shankar", sex: "male" }, { name: "Kiran Bedi", sex: "female" },
  { name: "Naveen Kumar", sex: "male" }, { name: "Asha Devi", sex: "female" },
];

const COMPLAINTS = [
  "Chest pain", "Fever for 3 days", "Abdominal pain", "Shortness of breath", "Headache",
  "Road traffic accident", "Fall from height", "Fracture, right leg", "Vomiting and diarrhea",
  "Uncontrolled diabetes", "Hypertension follow-up", "Post-operative review", "Cough and cold",
  "Palpitations", "Dizziness", "Back pain", "Joint pain", "Pregnancy check-up", "Pediatric fever",
  "Chronic kidney disease follow-up",
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

export async function seedHospital(prisma: PrismaClient) {
  const org = await prisma.organization.upsert({
    where: { id: "org-aarogya-health-network" },
    update: {},
    create: { id: "org-aarogya-health-network", name: "Aarogya Health Network" },
  });

  const facility = await prisma.facility.upsert({
    where: { id: "fac-amc-pune" },
    update: {},
    create: { id: "fac-amc-pune", name: "Aarogya Medical Centre", city: "Pune", organizationId: org.id },
  });

  const deptDefs = [
    { name: "Emergency", code: "ED" },
    { name: "General Medicine", code: "MED" },
    { name: "Cardiology", code: "CARD" },
    { name: "Orthopedics", code: "ORTHO" },
    { name: "Pediatrics", code: "PEDS" },
    { name: "General Surgery", code: "SURG" },
    { name: "Obstetrics & Gynecology", code: "OBG" },
    { name: "Neurology", code: "NEURO" },
  ];
  const departments = new Map<string, Awaited<ReturnType<typeof prisma.department.upsert>>>();
  for (const d of deptDefs) {
    const dept = await prisma.department.upsert({
      where: { facilityId_name: { facilityId: facility.id, name: d.name } },
      update: {},
      create: { facilityId: facility.id, name: d.name, code: d.code },
    });
    departments.set(d.name, dept);
  }

  const wardDefs: { name: string; type: WardType; deptName?: string; bedCount: number }[] = [
    { name: "Emergency Bay", type: WardType.EMERGENCY, deptName: "Emergency", bedCount: 6 },
    { name: "ICU", type: WardType.ICU, bedCount: 6 },
    { name: "General Ward A", type: WardType.GENERAL, deptName: "General Medicine", bedCount: 8 },
    { name: "General Ward B", type: WardType.GENERAL, deptName: "General Surgery", bedCount: 8 },
    { name: "Pediatric Ward", type: WardType.NICU, deptName: "Pediatrics", bedCount: 4 },
    { name: "Maternity Ward", type: WardType.SEMI_PRIVATE, deptName: "Obstetrics & Gynecology", bedCount: 4 },
    { name: "Private Rooms", type: WardType.PRIVATE, bedCount: 4 },
  ];

  const beds: Awaited<ReturnType<typeof prisma.bed.create>>[] = [];
  for (const w of wardDefs) {
    const ward = await prisma.ward.upsert({
      where: { facilityId_name: { facilityId: facility.id, name: w.name } },
      update: {},
      create: {
        facilityId: facility.id,
        name: w.name,
        wardType: w.type,
        departmentId: w.deptName ? departments.get(w.deptName)!.id : undefined,
      },
    });
    for (let i = 1; i <= w.bedCount; i++) {
      const label = `${w.name.split(" ").map((p) => p[0]).join("").toUpperCase()}-${i}`;
      const bed = await prisma.bed.upsert({
        where: { facilityId_label: { facilityId: facility.id, label } },
        update: {},
        create: {
          facilityId: facility.id,
          wardId: ward.id,
          label,
          isolationRequired: w.type === WardType.ISOLATION,
        },
      });
      beds.push(bed);
    }
  }

  // A few beds in non-AVAILABLE states so the Command Center / alert engine has real conditions to surface.
  const password = await hashPassword("Hospital@123");

  async function upsertStaffUser(email: string, displayName: string, role: Role, displayRole: string, deptName?: string) {
    const user = await prisma.user.upsert({
      where: { email }, update: {},
      create: { email, displayName, role, passwordHash: password },
    });
    await prisma.hospitalStaffProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        facilityId: facility.id,
        departmentId: deptName ? departments.get(deptName)?.id : undefined,
        displayRole,
        status: "ACTIVE",
      },
    });
    return user;
  }

  const hospitalAdmin = await upsertStaffUser("admin@amc-demo.aarogya", "Aarogya Medical Centre Admin", Role.HOSPITAL_ADMIN, "Hospital Administrator");

  const doctorUsers = [];
  for (let i = 0; i < DOCTOR_NAMES.length; i++) {
    const d = DOCTOR_NAMES[i];
    const email = `doctor${i + 1}@amc-demo.aarogya`;
    const user = await upsertStaffUser(email, d.name, Role.DOCTOR, d.specialty, d.specialty === "Emergency Medicine" ? "Emergency" : d.specialty);
    doctorUsers.push(user);
  }

  const nurseUsers = [];
  for (let i = 0; i < NURSE_NAMES.length; i++) {
    const email = `nurse${i + 1}@amc-demo.aarogya`;
    const user = await upsertStaffUser(email, NURSE_NAMES[i], Role.NURSE, "Staff Nurse");
    nurseUsers.push(user);
  }

  await upsertStaffUser("labtech@amc-demo.aarogya", "Vikram Solanki", Role.LAB_TECHNICIAN, "Lab Technician");
  await upsertStaffUser("radtech@amc-demo.aarogya", "Meena Joshi", Role.RADIOLOGY_TECH, "Radiology Technician");
  await upsertStaffUser("pharmacist@amc-demo.aarogya", "Divya Iyer", Role.PHARMACIST, "Pharmacist");
  await upsertStaffUser("billing@amc-demo.aarogya", "Suresh Naik", Role.BILLING_STAFF, "Billing Officer");

  const doctorProfiles = await prisma.hospitalStaffProfile.findMany({ where: { userId: { in: doctorUsers.map((u) => u.id) } } });
  const nurseProfiles = await prisma.hospitalStaffProfile.findMany({ where: { userId: { in: nurseUsers.map((u) => u.id) } } });
  const labTechProfile = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email: "labtech@amc-demo.aarogya" } } });
  const radTechProfile = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email: "radtech@amc-demo.aarogya" } } });

  // ── Patients ──────────────────────────────────────────────────────────
  const patients = [];
  for (let i = 0; i < PATIENT_NAMES.length; i++) {
    const p = PATIENT_NAMES[i];
    const uhid = `UHID-AMC-${String(1000 + i)}`;
    const patient = await prisma.patient.upsert({
      where: { uhid },
      update: {},
      create: {
        uhid,
        facilityId: facility.id,
        fullName: p.name,
        sex: p.sex,
        ageYears: 5 + ((i * 7) % 80),
        phone: `+91 98${String(200000 + i * 37).padStart(6, "0")}`,
        bloodGroup: pick(["A+", "B+", "O+", "AB+", "O-", "A-"], i),
      },
    });
    patients.push(patient);

    // A few patients get a documented allergy for the clinical-safety check to have something real to catch.
    if (i % 6 === 0) {
      await prisma.allergy.upsert({
        where: { id: `allergy-seed-${i}` },
        update: {},
        create: { id: `allergy-seed-${i}`, patientId: patient.id, substance: "penicillin", severity: "severe", reaction: "anaphylaxis" },
      });
    }
    if (i % 9 === 0) {
      await prisma.allergy.upsert({
        where: { id: `allergy-seed-b-${i}` },
        update: {},
        create: { id: `allergy-seed-b-${i}`, patientId: patient.id, substance: "sulfa drugs", severity: "moderate", reaction: "rash" },
      });
    }
  }

  // ── Encounters spanning OPD / ED / IPD, various statuses ────────────────
  // Unlike the upserts above, encounters/admissions/orders/charges are plain
  // creates — re-running this generator would duplicate clinical activity on
  // every seed run. Guard on "has this facility already been seeded with
  // clinical activity" so `npm run db:seed` stays safe to re-run (it will
  // still refresh users/departments/beds/cases, just skip re-generating
  // patient encounters once they exist).
  const existingEncounterCount = await prisma.encounter.count({ where: { facilityId: facility.id } });
  if (existingEncounterCount > 0) {
    console.log(`Hospital clinical activity already seeded (${existingEncounterCount} encounters) — skipping regeneration. Facility/staff/beds were still refreshed above.`);
    return { facility, hospitalAdmin };
  }

  let bedCursor = 0;
  const availableWardBeds = beds.filter((b) => b.status === BedStatus.AVAILABLE);

  for (let i = 0; i < patients.length; i++) {
    const patient = patients[i];
    const doctor = pick(doctorProfiles, i);
    const deptName = pick(deptDefs, i).name;
    const complaint = pick(COMPLAINTS, i);

    // Distribute encounter types/status realistically across the seed.
    const typeRoll = i % 5;
    const type: EncounterType = typeRoll === 0 ? EncounterType.ED : typeRoll === 1 ? EncounterType.IPD : EncounterType.OPD;

    let status: EncounterStatus = EncounterStatus.REGISTERED;
    if (i % 7 === 1) status = EncounterStatus.TRIAGED;
    else if (i % 7 === 2) status = EncounterStatus.IN_CONSULTATION;
    else if (i % 7 === 3) status = EncounterStatus.INVESTIGATING;
    else if (type === EncounterType.IPD) status = EncounterStatus.ADMITTED;
    else if (i % 7 === 5) status = EncounterStatus.DISCHARGED;

    const encounter = await prisma.encounter.create({
      data: {
        patientId: patient.id,
        facilityId: facility.id,
        departmentId: departments.get(deptName)?.id,
        type,
        status,
        chiefComplaint: complaint,
        triageLevel: type === EncounterType.ED ? 1 + (i % 5) : undefined,
        attendingStaffId: doctor.id,
        closedAt: status === EncounterStatus.DISCHARGED ? new Date() : undefined,
      },
    });

    // Vitals for anyone past triage.
    if (status !== EncounterStatus.REGISTERED) {
      await prisma.vital.create({
        data: {
          encounterId: encounter.id,
          recordedByStaffId: pick(nurseProfiles, i).id,
          hr: 70 + (i % 40),
          sbp: 100 + (i % 50),
          dbp: 60 + (i % 30),
          rr: 14 + (i % 10),
          spo2: 90 + (i % 10),
          tempC: 36.5 + (i % 4) * 0.5,
          painScore: i % 8,
        },
      });
    }

    // A note for anyone who's been seen.
    if (status === EncounterStatus.IN_CONSULTATION || status === EncounterStatus.INVESTIGATING || status === EncounterStatus.ADMITTED || status === EncounterStatus.DISCHARGED) {
      await prisma.clinicalNote.create({
        data: {
          encounterId: encounter.id,
          authorStaffId: doctor.id,
          type: "PROGRESS",
          content: { assessment: `${complaint} — working diagnosis pending further workup.`, plan: "Continue monitoring, review investigations." },
          status: "SIGNED",
          signedAt: new Date(),
        },
      });
    }

    // Admission + bed for IPD/ADMITTED encounters.
    if (status === EncounterStatus.ADMITTED && bedCursor < availableWardBeds.length) {
      const bed = availableWardBeds[bedCursor++];
      await prisma.bed.update({ where: { id: bed.id }, data: { status: BedStatus.OCCUPIED } });
      await prisma.bedStateEvent.create({
        data: { bedId: bed.id, fromStatus: BedStatus.AVAILABLE, toStatus: BedStatus.OCCUPIED, reason: `Admission: ${complaint}`, patientId: patient.id, encounterId: encounter.id },
      });
      const admission = await prisma.admission.create({
        data: { encounterId: encounter.id, bedId: bed.id, admittingStaffId: doctor.id, reason: complaint, expectedLosDays: 2 + (i % 5) },
      });

      // One stalled discharge (brief §36/§137 "12 discharge-ready patients waiting on pharmacy/billing").
      if (i % 11 === 0) {
        await prisma.discharge.create({
          data: {
            admissionId: admission.id,
            clinicallyReady: true,
            documentationReady: true,
            billingReady: false,
            insuranceReady: false,
            pharmacyReady: true,
            transportReady: true,
            initiatedAt: new Date(Date.now() - 9 * 3_600_000),
          },
        });
      }
    }

    // Lab orders for investigating/admitted patients.
    if (status === EncounterStatus.INVESTIGATING || status === EncounterStatus.ADMITTED) {
      const labOrder = await prisma.labOrder.create({
        data: {
          encounterId: encounter.id,
          patientId: patient.id,
          testName: pick(["CBC", "Troponin I", "Blood Glucose", "Electrolytes", "Liver Function Test"], i),
          category: "biochemistry",
          priority: i % 4 === 0 ? "STAT" : "ROUTINE",
          orderedByStaffId: doctor.id,
          status: "RESULTED",
        },
      });
      const isCritical = i % 8 === 0;
      await prisma.labResult.create({
        data: {
          labOrderId: labOrder.id,
          value: isCritical ? "9.8" : "5.2",
          unit: "mmol/L",
          referenceRange: "3.5-5.5",
          isCritical,
          releasedByStaffId: labTechProfile.id,
          acknowledgedAt: isCritical && i % 16 !== 0 ? new Date() : undefined,
          acknowledgedByStaffId: isCritical && i % 16 !== 0 ? doctor.userId : undefined,
        },
      });

      // Imaging for a subset.
      if (i % 3 === 0) {
        const imagingOrder = await prisma.imagingOrder.create({
          data: {
            encounterId: encounter.id,
            patientId: patient.id,
            modality: pick(["XRAY", "CT", "USG"], i),
            studyDescription: pick(["Chest X-ray", "CT Abdomen", "Abdominal ultrasound"], i),
            orderedByStaffId: doctor.id,
            status: "REPORTED",
          },
        });
        const imagingCritical = i % 13 === 0;
        await prisma.imagingReport.create({
          data: {
            imagingOrderId: imagingOrder.id,
            findings: imagingCritical ? "Free air under diaphragm suggestive of perforation." : "No acute abnormality.",
            impression: imagingCritical ? "Findings concerning for hollow viscus perforation — urgent surgical review advised." : "Unremarkable study.",
            isCritical: imagingCritical,
            reportedByStaffId: radTechProfile.id,
            verifiedAt: imagingCritical ? undefined : new Date(),
            verifiedByStaffId: imagingCritical ? undefined : doctor.userId,
          },
        });
      }
    }

    // Medication orders for admitted patients.
    if (status === EncounterStatus.ADMITTED) {
      const drug = pick(["Paracetamol", "Amoxicillin", "Metformin", "Atorvastatin", "Omeprazole"], i);
      const medOrder = await prisma.medicationOrder.create({
        data: {
          encounterId: encounter.id,
          patientId: patient.id,
          drugName: drug,
          genericName: drug.toLowerCase(),
          dose: "1 tablet",
          route: "oral",
          frequency: pick(["OD", "BD", "TDS"], i),
          durationDays: 5,
          orderedByStaffId: doctor.id,
        },
      });
      await prisma.medicationAdministration.createMany({
        data: [0, 1, 2].map((n) => ({
          medicationOrderId: medOrder.id,
          scheduledAt: new Date(Date.now() + (n - 1) * 8 * 3_600_000),
          status: n === 0 ? "GIVEN" : "DUE",
          administeredAt: n === 0 ? new Date(Date.now() - 8 * 3_600_000) : undefined,
          administeredByStaffId: n === 0 ? pick(nurseProfiles, i).id : undefined,
        })),
      });
    }

    // Charges + bill for anyone with a chief complaint (OPD consultation fee at minimum).
    const consultFee = 500 + (i % 5) * 200;
    await prisma.charge.create({
      data: { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, description: "Consultation fee", category: "CONSULTATION", amount: consultFee },
    });
    await prisma.bill.upsert({
      where: { encounterId: encounter.id },
      update: {},
      create: { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, totalAmount: consultFee },
    });

    // Problems for a subset — active diagnosis list.
    if (i % 4 === 0) {
      await prisma.problem.create({ data: { patientId: patient.id, diagnosis: complaint, status: "active", severity: "moderate" } });
    }
  }

  // Guaranteed alert-engine scenarios (rather than relying on modulo coincidence across the loop above) — an unacknowledged critical lab and an unverified critical imaging finding, so the Command Center demonstrably shows real safety alerts on first load.
  const alertPatient = patients[2];
  const alertEncounter = await prisma.encounter.create({
    data: {
      patientId: alertPatient.id, facilityId: facility.id, departmentId: departments.get("Emergency")!.id,
      type: EncounterType.ED, status: EncounterStatus.INVESTIGATING, chiefComplaint: "Severe abdominal pain", triageLevel: 2,
      attendingStaffId: doctorProfiles[0].id,
    },
  });
  const criticalLabOrder = await prisma.labOrder.create({
    data: { encounterId: alertEncounter.id, patientId: alertPatient.id, testName: "Troponin I", category: "biochemistry", priority: "STAT", orderedByStaffId: doctorProfiles[0].id, status: "RESULTED" },
  });
  await prisma.labResult.create({
    data: { labOrderId: criticalLabOrder.id, value: "2.8", unit: "ng/mL", referenceRange: "<0.04", isCritical: true, releasedByStaffId: labTechProfile.id },
  });
  const criticalImagingOrder = await prisma.imagingOrder.create({
    data: { encounterId: alertEncounter.id, patientId: alertPatient.id, modality: "CT", studyDescription: "CT Abdomen", orderedByStaffId: doctorProfiles[0].id, status: "REPORTED" },
  });
  await prisma.imagingReport.create({
    data: {
      imagingOrderId: criticalImagingOrder.id,
      findings: "Free air under diaphragm suggestive of hollow viscus perforation.",
      impression: "Findings concerning for perforation — urgent surgical review advised.",
      isCritical: true, reportedByStaffId: radTechProfile.id,
    },
  });

  // A couple of beds explicitly blocked/in-maintenance/cleaning so the alert engine and bed board have real, varied states to show (brief §195).
  const restBeds = beds.filter((b) => !availableWardBeds.slice(0, bedCursor).some((u) => u.id === b.id));
  if (restBeds[0]) {
    await prisma.bed.update({ where: { id: restBeds[0].id }, data: { status: BedStatus.MAINTENANCE } });
    await prisma.bedStateEvent.create({
      data: { bedId: restBeds[0].id, fromStatus: BedStatus.AVAILABLE, toStatus: BedStatus.MAINTENANCE, reason: "Oxygen outlet fault reported", createdAt: new Date(Date.now() - 14 * 3_600_000) },
    });
  }
  if (restBeds[1]) {
    await prisma.bed.update({ where: { id: restBeds[1].id }, data: { status: BedStatus.BLOCKED } });
    await prisma.bedStateEvent.create({
      data: { bedId: restBeds[1].id, fromStatus: BedStatus.AVAILABLE, toStatus: BedStatus.BLOCKED, reason: "Infection control hold pending terminal clean", createdAt: new Date(Date.now() - 6 * 3_600_000) },
    });
  }
  if (restBeds[2]) {
    await prisma.bed.update({ where: { id: restBeds[2].id }, data: { status: BedStatus.CLEANING } });
    await prisma.bedStateEvent.create({
      data: { bedId: restBeds[2].id, fromStatus: BedStatus.OCCUPIED, toStatus: BedStatus.CLEANING, reason: "Discharge", createdAt: new Date(Date.now() - 1 * 3_600_000) },
    });
  }

  console.log("Seeded hospital: Aarogya Medical Centre");
  console.log(`  ${departments.size} departments, ${wardDefs.length} wards, ${beds.length} beds`);
  console.log(`  ${DOCTOR_NAMES.length} doctors, ${NURSE_NAMES.length} nurses, 1 lab tech, 1 radiology tech, 1 pharmacist, 1 billing officer, 1 hospital admin`);
  console.log(`  ${patients.length} patients, ${patients.length} encounters`);
  console.log("  Demo logins (password Hospital@123): admin@amc-demo.aarogya, doctor1@amc-demo.aarogya, nurse1@amc-demo.aarogya, labtech@amc-demo.aarogya, radtech@amc-demo.aarogya, pharmacist@amc-demo.aarogya, billing@amc-demo.aarogya");

  return { facility, hospitalAdmin };
}
