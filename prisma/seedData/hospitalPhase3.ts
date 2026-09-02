/**
 * Phase 3 — Doctor OS / Nursing OS / Medication Lifecycle / Pharmacy demo
 * data. Idempotency-guarded on `CarePlan.count()`. Writes rows directly
 * via Prisma (same convention as every prior seed file — service
 * functions live in src/lib/hospital/* and are exercised live in the
 * Phase 3 verification pass, not re-invoked here against a second
 * PrismaClient instance).
 */
import { PrismaClient, MedicationOrderStatus } from "@prisma/client";

export async function seedPhase3Clinical(prisma: PrismaClient) {
  const already = await prisma.carePlan.count();
  if (already > 0) {
    console.log("Phase 3 clinical demo data already seeded — skipping.");
    return;
  }

  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const doctors = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facility.id, user: { role: "DOCTOR" } }, include: { user: true } });
  const nurses = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facility.id, user: { role: "NURSE" } } });
  const pharmacist = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "PHARMACIST" } } });
  const doctor = doctors[0];

  // ── Configurable abnormal-vital thresholds (brief §13) — explicit, hospital-configured example values, not a clinical claim ──
  const thresholds: { metric: string; minValue?: number; maxValue?: number }[] = [
    { metric: "hr", minValue: 40, maxValue: 140 },
    { metric: "sbp", minValue: 80, maxValue: 180 },
    { metric: "spo2", minValue: 92 },
    { metric: "tempC", minValue: 35, maxValue: 39 },
  ];
  for (const t of thresholds) {
    await prisma.vitalThreshold.upsert({
      where: { facilityId_metric: { facilityId: facility.id, metric: t.metric } },
      update: {},
      create: { facilityId: facility.id, metric: t.metric, minValue: t.minValue, maxValue: t.maxValue },
    });
  }

  // ── Scenario A: OPD medication (register -> ... -> order -> pharmacy -> dispense -> administer) ──
  const opdEncounter = await prisma.encounter.findFirst({ where: { facilityId: facility.id, type: "OPD", status: "REGISTERED" }, include: { patient: true } });
  if (opdEncounter) {
    const orderA = await prisma.order.create({
      data: { facilityId: facility.id, encounterId: opdEncounter.id, patientId: opdEncounter.patientId, orderingStaffId: doctor.id, orderType: "MEDICATION", indication: "Uncomplicated UTI" },
    });
    const medA = await prisma.medicationOrder.create({
      data: {
        encounterId: opdEncounter.id, patientId: opdEncounter.patientId, drugName: "Nitrofurantoin", genericName: "nitrofurantoin",
        dose: "100mg", route: "oral", frequency: "BD", durationDays: 5, orderedByStaffId: doctor.id,
        status: MedicationOrderStatus.PHARMACY_REVIEW, orderId: orderA.id, indication: "Uncomplicated UTI",
      },
    });
    await prisma.medicationAdministration.createMany({
      data: [0, 1, 2].map((n) => ({ medicationOrderId: medA.id, scheduledAt: new Date(Date.now() + n * 12 * 3_600_000) })),
    });
    await prisma.medicationVerification.create({ data: { medicationOrderId: medA.id, pharmacistStaffId: pharmacist.id, decision: "VERIFIED" } });
    await prisma.medicationOrder.update({ where: { id: medA.id }, data: { status: "VERIFIED" } });
    await prisma.dispensingRecord.create({ data: { medicationOrderId: medA.id, pharmacistStaffId: pharmacist.id, status: "FULL", quantity: 10, quantityUnit: "capsules", destination: "Patient (OPD pickup)" } });
    await prisma.medicationOrder.update({ where: { id: medA.id }, data: { status: "ACTIVE" } });
    const firstDoseA = await prisma.medicationAdministration.findFirst({ where: { medicationOrderId: medA.id }, orderBy: { scheduledAt: "asc" } });
    if (firstDoseA) {
      await prisma.medicationAdministration.update({
        where: { id: firstDoseA.id },
        data: { status: "GIVEN", administeredAt: new Date(), administeredByStaffId: nurses[0]?.id, safetyChecksConfirmed: true },
      });
    }
  }

  // ── Scenario B: IPD medication + nursing assignment + vitals + note + reconciliation ──
  const ipdEncounter = await prisma.encounter.findFirst({
    where: { facilityId: facility.id, status: "ADMITTED" },
    include: { patient: true, admission: { include: { bed: true } } },
  });
  if (ipdEncounter && ipdEncounter.admission) {
    await prisma.nursingAssignment.create({
      data: {
        facilityId: facility.id, nurseStaffId: nurses[1]?.id ?? nurses[0].id, patientId: ipdEncounter.patientId,
        encounterId: ipdEncounter.id, bedId: ipdEncounter.admission.bedId, reason: "Shift assignment", assignedByStaffId: nurses[1]?.id ?? nurses[0].id,
      },
    });

    const orderB = await prisma.order.create({
      data: { facilityId: facility.id, encounterId: ipdEncounter.id, patientId: ipdEncounter.patientId, orderingStaffId: doctor.id, orderType: "MEDICATION", indication: "Community-acquired pneumonia" },
    });
    const medB = await prisma.medicationOrder.create({
      data: {
        encounterId: ipdEncounter.id, patientId: ipdEncounter.patientId, drugName: "Ceftriaxone", genericName: "ceftriaxone",
        dose: "1g", route: "IV", frequency: "OD", durationDays: 7, orderedByStaffId: doctor.id,
        status: MedicationOrderStatus.PHARMACY_REVIEW, orderId: orderB.id, indication: "Community-acquired pneumonia",
      },
    });
    await prisma.medicationAdministration.createMany({ data: [0, 1].map((n) => ({ medicationOrderId: medB.id, scheduledAt: new Date(Date.now() + n * 24 * 3_600_000) })) });
    await prisma.medicationVerification.create({ data: { medicationOrderId: medB.id, pharmacistStaffId: pharmacist.id, decision: "VERIFIED" } });
    await prisma.medicationOrder.update({ where: { id: medB.id }, data: { status: "VERIFIED" } });
    await prisma.dispensingRecord.create({ data: { medicationOrderId: medB.id, pharmacistStaffId: pharmacist.id, status: "FULL", quantity: 7, quantityUnit: "vials", destination: "Ward stock" } });
    await prisma.medicationOrder.update({ where: { id: medB.id }, data: { status: "ACTIVE" } });

    await prisma.vital.create({
      data: { encounterId: ipdEncounter.id, recordedByStaffId: nurses[0]?.id ?? "seed", hr: 92, sbp: 118, dbp: 76, rr: 20, spo2: 95, tempC: 37.8, painScore: 2, consciousness: "Alert", o2DeliveryMethod: "room air" },
    });
    await prisma.clinicalNote.create({
      data: {
        encounterId: ipdEncounter.id, authorStaffId: doctor.id, authorRole: "DOCTOR", type: "DAILY_ROUND",
        content: { assessment: "Improving on IV antibiotics, afebrile trend.", plan: "Continue ceftriaxone, reassess CXR in 48h." },
        status: "SIGNED", signedAt: new Date(),
      },
    });

    // Care plan example matching the brief's own worked example.
    const carePlan = await prisma.carePlan.create({
      data: {
        patientId: ipdEncounter.patientId, encounterId: ipdEncounter.id, facilityId: facility.id,
        problem: "Pneumonia", goal: "Maintain SpO2 within the facility-configured target range",
        priority: "URGENT", createdByStaffId: doctor.id,
      },
    });
    await prisma.carePlanIntervention.createMany({
      data: [
        { carePlanId: carePlan.id, description: "Continuous oxygen saturation monitoring", responsibleRole: "Nursing" },
        { carePlanId: carePlan.id, description: "IV antibiotics per order", responsibleRole: "Nursing" },
        { carePlanId: carePlan.id, description: "Respiratory assessment each shift", responsibleRole: "Nursing" },
        { carePlanId: carePlan.id, description: "Repeat chest imaging at 48h", responsibleRole: "Radiology" },
      ],
    });

    await prisma.medicationReconciliation.create({
      data: {
        encounterId: ipdEncounter.id, patientId: ipdEncounter.patientId, facilityId: facility.id, source: "ADMISSION",
        medicationName: "Amlodipine 5mg OD", decision: "CONTINUED", reviewedByStaffId: doctor.id,
      },
    });
  }

  // ── Scenario C: Safety — documented allergy, conflicting order with override ──
  const allergyPatient = await prisma.patient.findFirst({ where: { facilityId: facility.id, allergies: { some: { substance: { contains: "penicillin" } } } }, include: { allergies: true } });
  const anyEncounterForAllergy = allergyPatient
    ? await prisma.encounter.findFirst({ where: { patientId: allergyPatient.id, facilityId: facility.id } })
    : null;
  if (allergyPatient && anyEncounterForAllergy) {
    const orderC = await prisma.order.create({
      data: { facilityId: facility.id, encounterId: anyEncounterForAllergy.id, patientId: allergyPatient.id, orderingStaffId: doctor.id, orderType: "MEDICATION", indication: "Skin infection" },
    });
    const medC = await prisma.medicationOrder.create({
      data: {
        encounterId: anyEncounterForAllergy.id, patientId: allergyPatient.id, drugName: "Amoxicillin", genericName: "amoxicillin",
        dose: "500mg", route: "oral", frequency: "TDS", orderedByStaffId: doctor.id, status: MedicationOrderStatus.PHARMACY_REVIEW,
        orderId: orderC.id, overrideReason: "No alternative narrow-spectrum agent available; dermatology aware, will monitor closely.",
        safetyFlags: [{ rule: "allergy-conflict", severity: "danger", message: "Documented severe allergy to penicillin.", sourceId: allergyPatient.allergies[0].id }],
      },
    });
    await prisma.medicationSafetyWarning.create({
      data: {
        medicationOrderId: medC.id, rule: "allergy-conflict", severity: "DANGER",
        message: `Patient has a documented severe allergy to "penicillin" — Amoxicillin is a penicillin-class antibiotic.`,
        sourceId: allergyPatient.allergies[0].id,
        overrideReason: "No alternative narrow-spectrum agent available; dermatology aware, will monitor closely.",
        acknowledgedByStaffId: doctor.id, acknowledgedAt: new Date(),
      },
    });
  }

  // ── Scenario D: Pharmacy rejection -> doctor corrects -> resubmit -> verified ──
  const rejectPatientEncounter = await prisma.encounter.findFirst({
    where: { facilityId: facility.id, type: "OPD", status: "REGISTERED", id: { not: opdEncounter?.id } },
  });
  if (rejectPatientEncounter) {
    const orderD = await prisma.order.create({
      data: { facilityId: facility.id, encounterId: rejectPatientEncounter.id, patientId: rejectPatientEncounter.patientId, orderingStaffId: doctor.id, orderType: "MEDICATION" },
    });
    const medD = await prisma.medicationOrder.create({
      data: {
        encounterId: rejectPatientEncounter.id, patientId: rejectPatientEncounter.patientId, drugName: "Metformin", genericName: "metformin",
        dose: "500mg", route: "IV", frequency: "OD", orderedByStaffId: doctor.id, status: MedicationOrderStatus.HELD, orderId: orderD.id,
      },
    });
    await prisma.medicationVerification.create({
      data: { medicationOrderId: medD.id, pharmacistStaffId: pharmacist.id, decision: "CLARIFICATION_REQUESTED", reason: "Metformin is not available as an IV formulation — please confirm route (oral intended?)." },
    });
  }

  // ── Scenario E: handoffs — one acknowledged, one pending ──
  const handoffPatient1 = ipdEncounter;
  const handoffPatient2 = opdEncounter;
  if (handoffPatient1 && doctors[1]) {
    const h = await prisma.clinicalHandoff.create({
      data: {
        facilityId: facility.id, patientId: handoffPatient1.patientId, encounterId: handoffPatient1.id, type: "DOCTOR",
        fromStaffId: doctor.id, toStaffId: doctors[1].id, urgency: "URGENT", summary: "Pneumonia, day 2 of IV ceftriaxone, monitor for deterioration overnight.",
        activeProblems: "Community-acquired pneumonia", pendingMedications: "Ceftriaxone 1g IV OD, day 3 due tomorrow",
        safetyConcerns: "None currently", escalationRequired: false,
      },
    });
    await prisma.clinicalHandoff.update({ where: { id: h.id }, data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedByStaffId: doctors[1].id } });
  }
  if (handoffPatient2 && nurses[2]) {
    await prisma.clinicalHandoff.create({
      data: {
        facilityId: facility.id, patientId: handoffPatient2.patientId, encounterId: handoffPatient2.id, type: "NURSE",
        fromStaffId: nurses[0].id, toStaffId: nurses[2].id, urgency: "ROUTINE", summary: "OPD follow-up, medication dispensed, awaiting first dose confirmation.",
        pendingMedications: "Nitrofurantoin 100mg BD x5 days",
      },
    });
  }

  console.log("Seeded Phase 3 clinical demo data: OPD/IPD medication lifecycle, safety override, pharmacy rejection, care plan, handoffs, vital thresholds.");
}
