/**
 * Batch 5, decision 1: charges posted without a tariff are NEEDS_PRICING;
 * an invoice carrying one can't be issued until billing prices it (from a
 * tariff code or an amount) or waives it with a reason code.
 *
 *   1. A theatre item with no tariff is charged NEEDS_PRICING at 0.
 *   2. issueInvoice refuses while a line needs pricing.
 *   3. priceCharge (explicit amount) updates the charge and its DRAFT line,
 *      emits ChargeRepriced, is audited; the invoice then issues with the price.
 *   4. priceCharge from a tariff code uses the server-side price.
 *   5. waiveCharge with a reason → WAIVED at 0, ChargeWaived, audited; the
 *      invoice issues. A resolved charge can't be priced or waived again.
 *   6. The database refuses a NEEDS_PRICING charge with an amount, and a
 *      WAIVED one without a reason.
 *   7. The seeded tariffs exist: PROCEDURE:GENERIC, BLOOD:GENERIC,
 *      ICU:ADMISSION and ITEM:<sku> for the seeded consumables.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-needs-pricing.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { requestSurgery, transitionSurgery, recordItemUsage } from "../src/lib/hospital/surgery";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, InvoiceNeedsPricingError } from "../src/lib/hospital/billing/invoices";
import { priceCharge, waiveCharge, ChargeNotAwaitingPriceError } from "../src/lib/hospital/billing/chargePricing";
import { runTick } from "../src/lib/runner/tick";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };
const failsWith = <T>(p: Promise<T>, cls: new (...a: never[]) => Error) => p.then(() => false, (e) => e instanceof cls);
const rejects = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Needs Pricing ${run}`, sex: "M", ageYears: 44 });

  /** An encounter with one theatre item (not seeded, so no tariff) charged by the consumer. */
  const unpricedEncounter = async (label: string) => {
    const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: label, byUserId: by });
    const item = await prisma.item.create({ data: { facilityId, sku: `NP-${label}-${run}`, name: `Probe item ${label}`, category: "CONSUMABLE", baseUnit: "PIECE" } });
    const s = await requestSurgery({ facilityId, patientId: patient.id, encounterId: enc.id, procedureName: `Probe ${label}`, requestedByStaffId: doctor.id, byUserId: by });
    await transitionSurgery({ surgeryId: s.id, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
    await transitionSurgery({ surgeryId: s.id, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
    const usage = await recordItemUsage({ surgeryId: s.id, facilityId, usageType: "CONSUMABLE", itemId: item.id, quantity: 2, recordedByStaffId: doctor.id, actorUserId: by, byUserId: by });
    await drain();
    const charge = await prisma.charge.findFirstOrThrow({ where: { sourceType: "SurgeryItemUsage", sourceId: usage.id } });
    const invoice = await prisma.$transaction(async (tx) => {
      const inv = await draftInvoiceForAccount(tx, { encounterId: enc.id, patientId: patient.id, facilityId, generatedByUserId: by });
      return addChargeToInvoice(tx, inv.id, charge.id);
    });
    return { enc, charge, invoice };
  };

  // 1–3. Price by amount.
  const a = await unpricedEncounter("A");
  report("A theatre item with no tariff is charged NEEDS_PRICING at 0", a.charge.pricingStatus === "NEEDS_PRICING" && a.charge.netAmountMinor === 0);
  report("issueInvoice refuses while a line needs pricing", await failsWith(prisma.$transaction((tx) => issueInvoice(tx, a.invoice.id, {})), InvoiceNeedsPricingError));
  const priced = await prisma.$transaction((tx) => priceCharge(tx, a.charge.id, { unitPriceMinor: 12_345, byUserId: by }));
  const line = await prisma.invoiceLine.findUniqueOrThrow({ where: { chargeId: a.charge.id } });
  report("priceCharge sets the price (quantity 2 → 24 690), drops the marker, and updates the DRAFT line",
    priced.pricingStatus === "PRICED" && priced.netAmountMinor === 24_690 && !priced.description.includes("needs pricing") && line.netAmountMinor === 24_690 && priced.pricedByUserId === by);
  const repriced = await prisma.domainEventOutbox.findFirst({ where: { eventType: "ChargeRepriced", aggregateId: a.charge.id } });
  report("…emits ChargeRepriced (amounts, no text) and is audited",
    (repriced?.payload as { netAmountMinor?: number } | undefined)?.netAmountMinor === 24_690 && repriced?.correlationId === a.enc.id
      && (await prisma.auditEvent.count({ where: { type: "hospital.billing.chargePriced", encounterId: a.enc.id } })) === 1);
  const issued = await prisma.$transaction((tx) => issueInvoice(tx, a.invoice.id, {}));
  report("…and the invoice then issues with the price", issued.status === "ISSUED" && issued.totalMinor === 24_690);

  // 4. Price from a tariff code.
  const b = await unpricedEncounter("B");
  const tariff = await prisma.tariff.findFirstOrThrow({ where: { facilityId, chargeCode: "PROCEDURE:GENERIC", active: true } });
  const fromTariff = await prisma.$transaction((tx) => priceCharge(tx, b.charge.id, { chargeCode: "PROCEDURE:GENERIC", byUserId: by }));
  report("priceCharge from a tariff code uses the server-side price", fromTariff.unitPriceMinor === tariff.unitPriceMinor && fromTariff.chargeCode === "PROCEDURE:GENERIC");

  // 5. Waive.
  const c = await unpricedEncounter("C");
  const waived = await prisma.$transaction((tx) => waiveCharge(tx, c.charge.id, { reasonCode: "GOODWILL", byUserId: by }));
  const waivedEvent = await prisma.domainEventOutbox.findFirst({ where: { eventType: "ChargeWaived", aggregateId: c.charge.id } });
  report("waiveCharge → WAIVED at 0 with the reason; ChargeWaived; audited",
    waived.pricingStatus === "WAIVED" && waived.waiverReason === "GOODWILL" && waived.netAmountMinor === 0
      && (waivedEvent?.payload as { reasonCode?: string } | undefined)?.reasonCode === "GOODWILL"
      && (await prisma.auditEvent.count({ where: { type: "hospital.billing.chargeWaived", encounterId: c.enc.id } })) === 1);
  report("…the invoice issues (a waived line is not 'needs pricing')", (await prisma.$transaction((tx) => issueInvoice(tx, c.invoice.id, {}))).status === "ISSUED");
  report("A resolved charge can't be priced or waived again",
    await failsWith(prisma.$transaction((tx) => priceCharge(tx, a.charge.id, { unitPriceMinor: 1, byUserId: by })), ChargeNotAwaitingPriceError)
      && await failsWith(prisma.$transaction((tx) => waiveCharge(tx, c.charge.id, { reasonCode: "OTHER", byUserId: by })), ChargeNotAwaitingPriceError));

  // 6. Database constraints.
  report("The database refuses a NEEDS_PRICING charge with an amount",
    await rejects(prisma.$executeRaw`UPDATE "Charge" SET "pricingStatus" = 'NEEDS_PRICING' WHERE id = ${a.charge.id}`));
  report("…and a WAIVED charge with no reason",
    await rejects(prisma.$executeRaw`UPDATE "Charge" SET "waiverReason" = NULL WHERE id = ${c.charge.id}`));

  // 7. Seeded tariffs.
  const codes = (await prisma.tariff.findMany({ where: { facilityId, active: true, chargeCode: { in: ["PROCEDURE:GENERIC", "BLOOD:GENERIC", "ICU:ADMISSION"] } }, select: { chargeCode: true } })).map((t) => t.chargeCode).sort();
  const seededItem = await prisma.item.findFirst({ where: { facilityId, category: "CONSUMABLE", sku: { startsWith: "CONS-" } } });
  const itemTariff = seededItem ? await prisma.tariff.count({ where: { facilityId, chargeCode: `ITEM:${seededItem.sku}`, active: true } }) : 0;
  report("Seeded tariffs: PROCEDURE:GENERIC, BLOOD:GENERIC, ICU:ADMISSION and the seeded consumables", codes.join() === "BLOOD:GENERIC,ICU:ADMISSION,PROCEDURE:GENERIC" && itemTariff === 1, `${codes.join()} item=${itemTariff}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
