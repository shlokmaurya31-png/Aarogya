import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError, type DomainEventEnvelope } from "@/lib/events/types";
import { createChargeIfNotExists, CHARGE_CAPTURE_TRIGGERS } from "@/lib/hospital/billing/chargeCapture";
import { priceFor, PriceNotFoundError } from "@/lib/hospital/billing/pricing";

/**
 * charge-capture (workflow spine §2, §5.2): the NEW charges only. Lab,
 * imaging, pharmacy, bed-days and packages stay in their own transactions.
 *
 *   ProcedureCompleted  → (Surgery, surgeryId)            procedure fee
 *   SurgeryItemUsed     → (SurgeryItemUsage, usageId)     implant / consumable
 *   BloodIssued         → (BloodIssue, issueId)           blood component
 *   IcuAdmitted         → (IcuAdmission, admissionId)     ICU admission fee
 *   EncounterOpened     → (Encounter, encounterId)        OPD consultation, only where tariffed
 *   PatientTriaged      → (TriageAssessment, triageId)    ED triage fee, only where tariffed
 *
 * Idempotent: Charge (sourceType, sourceId) is unique and the insert is
 * ON CONFLICT DO NOTHING, so redelivery (or an in-transaction path for the
 * same source) never charges twice. Pricing: the specific tariff, then the
 * generic one; with neither, a zero-priced charge marked "needs pricing" (never
 * blocks, never silently skips), except consultation and triage, which are
 * charged only where a tariff exists. A charge for an encounter whose invoice
 * is already issued is recorded like any other, marked late, with a billing
 * exception task (chargeCapture.ts), and collected on a supplementary invoice.
 * Re-reads everything and checks the event's tenant.
 */
interface ChargeSpec {
  encounterId: string;
  sourceType: string;
  sourceId: string;
  category: "PROCEDURE" | "CONSULTATION" | "OTHER";
  description: string;
  /** Tariff codes in order of preference. */
  codes: string[];
  quantity?: number;
  /** Charge only when one of the codes has a tariff. */
  onlyWhereTariffed?: boolean;
}

async function postCharge(event: DomainEventEnvelope, spec: ChargeSpec) {
  const enc = await prisma.encounter.findUnique({ where: { id: spec.encounterId }, select: { id: true, facilityId: true, patientId: true } });
  if (!enc || enc.facilityId !== event.facilityId) throw new PermanentEventError(`Encounter ${spec.encounterId} is not in the event's facility.`, "TENANT_MISMATCH");
  if (await prisma.charge.findFirst({ where: { sourceType: spec.sourceType, sourceId: spec.sourceId }, select: { id: true } })) return; // already charged

  let price: { unitPriceMinor: number; currency: string } | null = null;
  let code = spec.codes[0];
  for (const c of spec.codes) {
    try {
      price = await priceFor(enc.facilityId, c, event.occurredAt);
      code = c;
      break;
    } catch (err) {
      if (!(err instanceof PriceNotFoundError)) throw err;
    }
  }
  if (!price && spec.onlyWhereTariffed) return;

  await prisma.$transaction((tx) => createChargeIfNotExists(tx, {
    encounterId: enc.id, patientId: enc.patientId, facilityId: enc.facilityId, category: spec.category,
    description: price ? spec.description : `${spec.description} (needs pricing)`, chargeCode: code,
    quantity: spec.quantity ?? 1, unitPriceMinor: price?.unitPriceMinor ?? 0, currency: price?.currency ?? "INR",
    sourceType: spec.sourceType, sourceId: spec.sourceId, postedByUserId: event.actorUserId,
    pricingStatus: price ? "PRICED" : "NEEDS_PRICING",
  }));
}

export const chargeCapture: DomainEventConsumer = {
  name: "charge-capture",
  handles: CHARGE_CAPTURE_TRIGGERS,
  async handle(event) {
    const p = event.payload as Record<string, string | number | boolean | undefined>;
    switch (event.eventType) {
      case "ProcedureCompleted": {
        const s = await prisma.surgery.findUnique({ where: { id: String(p.surgeryId) }, select: { encounterId: true, procedureName: true, procedure: { select: { code: true } } } });
        if (!s) throw new PermanentEventError(`Surgery ${p.surgeryId} not found.`, "NOT_FOUND");
        return postCharge(event, {
          encounterId: s.encounterId, sourceType: "Surgery", sourceId: String(p.surgeryId), category: "PROCEDURE",
          description: `Procedure: ${s.procedureName}`, codes: [...(s.procedure ? [`PROCEDURE:${s.procedure.code}`] : []), "PROCEDURE:GENERIC"],
        });
      }
      case "SurgeryItemUsed": {
        const u = await prisma.surgeryItemUsage.findUnique({ where: { id: String(p.usageId) }, select: { encounterId: true, usageType: true, quantity: true, itemId: true } });
        if (!u) throw new PermanentEventError(`Item usage ${p.usageId} not found.`, "NOT_FOUND");
        const item = await prisma.item.findUnique({ where: { id: u.itemId }, select: { sku: true, name: true } });
        if (!item) throw new PermanentEventError(`Item ${u.itemId} not found.`, "NOT_FOUND");
        return postCharge(event, {
          encounterId: u.encounterId, sourceType: "SurgeryItemUsage", sourceId: String(p.usageId), category: "OTHER", quantity: u.quantity,
          description: `${u.usageType === "IMPLANT" ? "Implant" : "Surgical consumable"}: ${item.name}`, codes: [`ITEM:${item.sku}`, `OT_${u.usageType}:GENERIC`],
        });
      }
      case "BloodIssued": {
        const i = await prisma.bloodIssue.findUnique({ where: { id: String(p.issueId) }, select: { encounterId: true, unit: { select: { product: { select: { code: true, name: true } } } } } });
        if (!i) throw new PermanentEventError(`Blood issue ${p.issueId} not found.`, "NOT_FOUND");
        return postCharge(event, {
          encounterId: i.encounterId, sourceType: "BloodIssue", sourceId: String(p.issueId), category: "OTHER",
          description: `Blood component: ${i.unit.product.name}`, codes: [`BLOOD:${i.unit.product.code}`, "BLOOD:GENERIC"],
        });
      }
      case "IcuAdmitted":
        return postCharge(event, {
          encounterId: String(p.encounterId), sourceType: "IcuAdmission", sourceId: String(p.admissionId), category: "OTHER",
          description: "ICU admission", codes: ["ICU:ADMISSION"],
        });
      case "EncounterOpened":
        if (p.encounterType !== "OPD") return;
        return postCharge(event, {
          encounterId: String(p.encounterId), sourceType: "Encounter", sourceId: String(p.encounterId), category: "CONSULTATION",
          description: "OPD consultation", codes: ["CONSULT_OPD"], onlyWhereTariffed: true,
        });
      case "PatientTriaged": {
        const enc = await prisma.encounter.findUnique({ where: { id: String(p.encounterId) }, select: { type: true } });
        if (enc?.type !== "ED") return;
        return postCharge(event, {
          encounterId: String(p.encounterId), sourceType: "TriageAssessment", sourceId: String(p.triageId), category: "CONSULTATION",
          description: "ED triage", codes: ["ED:TRIAGE"], onlyWhereTariffed: true,
        });
      }
    }
  },
};
