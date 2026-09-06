/**
 * Phase 5 — Billing + Insurance + Revenue Cycle demo data. Idempotency-
 * guarded on `Tariff.count()`. Backfills the sentinel CASH payer and a
 * facility-scoped tariff for every existing billable service (lab/imaging
 * catalog, consultation, generic pharmacy, bed-day per ward type actually
 * seeded), adds one demo insurance payer + coverage for a couple of
 * patients, and drives one small end-to-end invoice -> payment -> claim
 * chain through the real service functions (same convention as every
 * prior seed file exercising src/lib/hospital/* directly).
 */
import { PrismaClient } from "@prisma/client";
import { createTariff } from "../../src/lib/hospital/billing/pricing";
import { getOrCreateBillingAccount } from "../../src/lib/hospital/billing/billingAccount";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice } from "../../src/lib/hospital/billing/invoices";
import { recordPayment, allocatePayment } from "../../src/lib/hospital/billing/payments";
import { addPatientCoverage } from "../../src/lib/hospital/billing/coverage";
import { createClaimDraft, submitClaim, recordClaimDecision } from "../../src/lib/hospital/billing/claims";

const DEMO_CASH_PAYER_NAME = "Cash / Self-Pay";
const DEMO_INSURER_NAME = "Star Universal Health Insurance (Demo)";

export async function seedPhase5Billing(prisma: PrismaClient) {
  const already = await prisma.tariff.count();
  if (already > 0) {
    console.log("Phase 5 billing demo data already seeded — skipping.");
    return;
  }

  const cashPayer = await prisma.payer.upsert({
    where: { id: "payer-cash-selfpay" },
    update: {},
    create: { id: "payer-cash-selfpay", name: DEMO_CASH_PAYER_NAME, type: "CASH" },
  });

  const insurer = await prisma.payer.upsert({
    where: { id: "payer-demo-insurer" },
    update: {},
    create: { id: "payer-demo-insurer", name: DEMO_INSURER_NAME, type: "INSURANCE" },
  });
  const insurerPlan = await prisma.payerPlan.upsert({
    where: { payerId_name: { payerId: insurer.id, name: "Family Floater Gold" } },
    update: {},
    create: { payerId: insurer.id, name: "Family Floater Gold", planCode: "FFG-01", copayPercent: 10 },
  });

  const facilities = await prisma.facility.findMany();
  const billingStaffByFacility = new Map<string, { userId: string }>();
  const effectiveFrom = new Date("2026-01-01");

  for (const facility of facilities) {
    const billingStaff = await prisma.hospitalStaffProfile.findFirst({ where: { facilityId: facility.id, user: { role: "BILLING_STAFF" } } });
    const admin = await prisma.hospitalStaffProfile.findFirst({ where: { facilityId: facility.id, user: { role: "HOSPITAL_ADMIN" } } });
    const createdByUser = billingStaff ?? admin;
    if (!createdByUser) continue; // a facility with neither role seeded has nothing to attribute tariffs to — skip rather than fabricate an actor
    billingStaffByFacility.set(facility.id, { userId: createdByUser.userId });

    await prisma.$transaction(async (tx) => {
      // Consultation + generic fallbacks (unlisted lab test/imaging study/drug) — flat facility-wide rates, used when no catalog-linked or free-text-specific tariff exists.
      await createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode: "CONSULT_OPD", description: "OPD Consultation", category: "CONSULTATION", unitPriceMinor: 50000, effectiveFrom, createdByUserId: createdByUser.userId });
      await createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode: "PHARMACY:GENERIC", description: "Pharmacy (unlisted drug, generic rate)", category: "PHARMACY", unitPriceMinor: 15000, effectiveFrom, createdByUserId: createdByUser.userId });
      await createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode: "LAB:GENERIC", description: "Lab test (unlisted, generic rate)", category: "LAB", unitPriceMinor: 30000, effectiveFrom, createdByUserId: createdByUser.userId });
      await createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode: "IMAGING:GENERIC", description: "Imaging study (unlisted, generic rate)", category: "IMAGING", unitPriceMinor: 150000, effectiveFrom, createdByUserId: createdByUser.userId });

      // Lab/imaging catalog — global (facilityId: null) and facility-scoped rows both get a facility-specific Tariff row (Tariff itself is never global — see its schema doc comment).
      const [labTests, imagingTests] = await Promise.all([
        tx.labTestCatalog.findMany({ where: { OR: [{ facilityId: null }, { facilityId: facility.id }] } }),
        tx.imagingCatalog.findMany({ where: { OR: [{ facilityId: null }, { facilityId: facility.id }] } }),
      ]);
      for (const test of labTests) {
        await createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode: test.code, description: test.name, category: "LAB", unitPriceMinor: Math.round(test.demoPriceInr * 100), effectiveFrom, createdByUserId: createdByUser.userId });
      }
      for (const study of imagingTests) {
        await createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode: study.code, description: study.name, category: "IMAGING", unitPriceMinor: Math.round(study.demoPriceInr * 100), effectiveFrom, createdByUserId: createdByUser.userId });
      }

      // Bed-day — one tariff per ward type actually seeded at this facility, priced by acuity.
      const wardTypes = await tx.ward.findMany({ where: { facilityId: facility.id }, distinct: ["wardType"], select: { wardType: true } });
      const bedDayRateMinor: Record<string, number> = {
        GENERAL: 150000, SEMI_PRIVATE: 250000, PRIVATE: 450000, ICU: 900000, HDU: 600000,
        NICU: 800000, PICU: 850000, EMERGENCY: 200000, ISOLATION: 350000, OT_RECOVERY: 300000,
      };
      for (const { wardType } of wardTypes) {
        await createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode: `BED_DAY:${wardType}`, description: `Bed charge — ${wardType}`, category: "BED", unitPriceMinor: bedDayRateMinor[wardType] ?? 150000, effectiveFrom, createdByUserId: createdByUser.userId });
      }
    });
  }
  console.log(`Seeded billing tariffs for ${facilities.length} facilit${facilities.length === 1 ? "y" : "ies"} (CASH payer + demo insurer "${DEMO_INSURER_NAME}" with plan "${insurerPlan.name}").`);

  // Demo coverage for a couple of patients at the primary demo facility.
  const amc = await prisma.facility.findFirst({ where: { name: "Aarogya Medical Centre" } });
  const amcBillingActor = amc ? billingStaffByFacility.get(amc.id) : undefined;
  if (amc && amcBillingActor) {
    const coveredPatients = await prisma.patient.findMany({ where: { facilityId: amc.id }, take: 2 });
    for (const [idx, patient] of coveredPatients.entries()) {
      await prisma.$transaction((tx) =>
        addPatientCoverage(tx, {
          patientId: patient.id,
          payerId: insurer.id,
          planId: insurerPlan.id,
          memberId: `DEMO-MEM-${1000 + idx}`,
          validFrom: new Date("2026-01-01"),
          validTo: new Date("2027-12-31"),
          addedByUserId: amcBillingActor.userId,
        })
      );
    }
    console.log(`Seeded demo insurance coverage for ${coveredPatients.length} patient(s) at ${amc.name}.`);

    // One small end-to-end demo chain: an encounter with an existing
    // consultation charge (from seedHospital) gets drafted, issued, and
    // partially paid — a realistic, inspectable demo state rather than a
    // synthetic fixture with no history behind it.
    const chargedEncounter = await prisma.encounter.findFirst({
      where: { facilityId: amc.id, charges: { some: { status: "POSTED" } }, invoices: { none: {} } },
      include: { charges: { where: { status: "POSTED" } } },
    });
    if (chargedEncounter) {
      const invoiceChain = await prisma.$transaction(async (tx) => {
        await getOrCreateBillingAccount(tx, { encounterId: chargedEncounter.id, patientId: chargedEncounter.patientId, facilityId: amc.id });
        const draft = await draftInvoiceForAccount(tx, { encounterId: chargedEncounter.id, patientId: chargedEncounter.patientId, facilityId: amc.id, generatedByUserId: amcBillingActor.userId });
        for (const charge of chargedEncounter.charges) await addChargeToInvoice(tx, draft.id, charge.id);
        const issued = await issueInvoice(tx, draft.id, {});
        const { payment } = await recordPayment(tx, {
          encounterId: chargedEncounter.id,
          patientId: chargedEncounter.patientId,
          facilityId: amc.id,
          amountMinor: Math.floor(issued.totalMinor / 2),
          method: "CASH",
          idempotencyKey: `seed-demo-payment-${chargedEncounter.id}`,
          receivedByUserId: amcBillingActor.userId,
        });
        await allocatePayment(tx, { paymentId: payment.id, invoiceId: issued.id, amountMinor: Math.floor(issued.totalMinor / 2), allocatedByUserId: amcBillingActor.userId });
        return issued;
      });
      console.log(`Seeded a demo invoice (${invoiceChain.invoiceNumber}) with a partial cash payment for encounter ${chargedEncounter.id}.`);
    }

    // A second demo chain showing the claim lifecycle mid-flight (UNDER_REVIEW) — a distinct encounter from the one above.
    const secondEncounter = await prisma.encounter.findFirst({
      where: { facilityId: amc.id, patientId: coveredPatients[0]?.id, charges: { some: { status: "POSTED" } }, invoices: { none: {} } },
      include: { charges: { where: { status: "POSTED" } } },
    });
    const coverage = coveredPatients[0] ? await prisma.patientCoverage.findFirst({ where: { patientId: coveredPatients[0].id, payerId: insurer.id } }) : null;
    if (secondEncounter && coverage) {
      await prisma.$transaction(async (tx) => {
        await getOrCreateBillingAccount(tx, { encounterId: secondEncounter.id, patientId: secondEncounter.patientId, facilityId: amc.id });
        const draft = await draftInvoiceForAccount(tx, { encounterId: secondEncounter.id, patientId: secondEncounter.patientId, facilityId: amc.id, payerId: insurer.id, generatedByUserId: amcBillingActor.userId });
        for (const charge of secondEncounter.charges) await addChargeToInvoice(tx, draft.id, charge.id);
        const issued = await issueInvoice(tx, draft.id, {});
        const claim = await createClaimDraft(tx, { invoiceId: issued.id, coverageId: coverage.id, facilityId: amc.id, createdByUserId: amcBillingActor.userId });
        const submitted = await submitClaim(tx, claim.id);
        await recordClaimDecision(tx, submitted.id, { status: "UNDER_REVIEW" });
      });
      console.log(`Seeded a demo insurance claim (UNDER_REVIEW) for encounter ${secondEncounter.id}.`);
    }
  }
}
