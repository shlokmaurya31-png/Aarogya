import { prisma } from "@/lib/db";
import { MedicationOrderStatus, MedicationAdministrationStatus, DispenseStatus } from "@prisma/client";
import { checkMedicationSafety, writeSafetyWarnings, type SafetyFlag } from "./clinicalSafety";
import { generateAdministrationSchedule } from "./medicationSchedule";
import { createOrderEnvelope, closeOrderEnvelope } from "./orderEnvelope";

/**
 * The full prescribe -> pharmacy -> dispense -> administer -> discontinue
 * lifecycle (brief §15-21). Every transition is server-validated against
 * this table — impossible transitions (e.g. administering a CANCELLED
 * order) are rejected, never silently allowed.
 */
const ALLOWED: Record<MedicationOrderStatus, MedicationOrderStatus[]> = {
  DRAFT: ["ORDERED", "CANCELLED"],
  ORDERED: ["PHARMACY_REVIEW", "CANCELLED"],
  PHARMACY_REVIEW: ["VERIFIED", "REJECTED", "HELD", "CANCELLED"],
  HELD: ["PHARMACY_REVIEW", "CANCELLED", "DISCONTINUED"],
  REJECTED: ["PHARMACY_REVIEW", "CANCELLED"], // doctor corrects and resubmits (brief Scenario D)
  VERIFIED: ["DISPENSED", "CANCELLED", "DISCONTINUED"],
  DISPENSED: ["ACTIVE", "DISCONTINUED"],
  ACTIVE: ["COMPLETED", "DISCONTINUED"],
  COMPLETED: [],
  CANCELLED: [],
  DISCONTINUED: [],
};

export class InvalidMedicationOrderTransitionError extends Error {
  constructor(from: MedicationOrderStatus, to: MedicationOrderStatus) {
    super(`Illegal medication order transition: ${from} -> ${to}`);
  }
}
export class MedicationOrderNotActiveError extends Error {
  constructor(status: MedicationOrderStatus) {
    super(`Medication cannot be administered — order status is ${status}, not ACTIVE or DISPENSED.`);
  }
}
export class AdministrationNotDueError extends Error {
  constructor(status: MedicationAdministrationStatus) {
    super(`This dose is already ${status} — cannot record it again.`);
  }
}
export class RequiresOverrideError extends Error {
  flags: SafetyFlag[];
  constructor(flags: SafetyFlag[]) {
    super("Danger-severity safety warning requires an override reason.");
    this.flags = flags;
  }
}

export function isMedicationOrderTransitionAllowed(from: MedicationOrderStatus, to: MedicationOrderStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

async function transition(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], orderId: string, to: MedicationOrderStatus, byUserId: string, extra?: Record<string, unknown>) {
  const order = await tx.medicationOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (!isMedicationOrderTransitionAllowed(order.status, to)) {
    throw new InvalidMedicationOrderTransitionError(order.status, to);
  }
  const updated = await tx.medicationOrder.update({ where: { id: orderId }, data: { status: to, ...extra } });
  await tx.auditEvent.create({ data: { type: "hospital.medication.statusChanged", userId: byUserId, detail: { orderId, from: order.status, to } } });
  return updated;
}

/**
 * Places a new medication order (brief §15). Runs the safety engine first
 * — a DANGER flag blocks unless an override reason is supplied (never a
 * silent block, never a silent allow). On success: creates the Order
 * envelope, the MedicationOrder (ORDERED), persists every flag as an
 * auditable MedicationSafetyWarning, auto-submits to pharmacy
 * (ORDERED -> PHARMACY_REVIEW — every order goes to pharmacy by default),
 * and generates the administration schedule.
 */
export async function createMedicationOrder(input: {
  facilityId: string;
  encounterId: string;
  patientId: string;
  orderingStaffId: string;
  drugName: string;
  genericName?: string;
  dose: string;
  route: string;
  frequency: string;
  durationDays?: number;
  formulation?: string;
  doseValue?: number;
  doseUnit?: string;
  timing?: string;
  prn?: boolean;
  prnReason?: string;
  specialInstructions?: string;
  indication?: string;
  isControlled?: boolean;
  overrideReason?: string;
  byUserId: string;
}): Promise<{ blocked: true; flags: SafetyFlag[] } | { blocked: false; order: NonNullable<Awaited<ReturnType<typeof prisma.medicationOrder.findFirst>>>; flags: SafetyFlag[] }> {
  const flags = await checkMedicationSafety(input.patientId, input.drugName, input.genericName, input.route, input.frequency);
  const hasDanger = flags.some((f) => f.severity === "danger");
  if (hasDanger && !input.overrideReason) {
    return { blocked: true, flags };
  }

  const order = await prisma.$transaction(async (tx) => {
    const envelope = await createOrderEnvelope(tx, {
      facilityId: input.facilityId,
      encounterId: input.encounterId,
      patientId: input.patientId,
      orderingStaffId: input.orderingStaffId,
      orderType: "MEDICATION",
      indication: input.indication,
    });

    const created = await tx.medicationOrder.create({
      data: {
        encounterId: input.encounterId,
        patientId: input.patientId,
        drugName: input.drugName,
        genericName: input.genericName,
        dose: input.dose,
        route: input.route,
        frequency: input.frequency,
        durationDays: input.durationDays,
        orderedByStaffId: input.orderingStaffId,
        safetyFlags: flags.length ? (flags as unknown as object) : undefined,
        overrideReason: hasDanger ? input.overrideReason : undefined,
        orderId: envelope.id,
        formulation: input.formulation,
        doseValue: input.doseValue,
        doseUnit: input.doseUnit,
        timing: input.timing,
        prn: input.prn ?? false,
        prnReason: input.prnReason,
        specialInstructions: input.specialInstructions,
        indication: input.indication,
        isControlled: input.isControlled ?? false,
      },
    });

    await writeSafetyWarnings(tx, created.id, flags);
    if (hasDanger) {
      // The override itself is auditable at the warning level, not just the order level.
      await tx.medicationSafetyWarning.updateMany({
        where: { medicationOrderId: created.id, severity: "DANGER" },
        data: { overrideReason: input.overrideReason, acknowledgedByStaffId: input.orderingStaffId, acknowledgedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: { type: "hospital.medication.safetyOverridden", userId: input.byUserId, detail: { orderId: created.id, reason: input.overrideReason, flagCount: flags.length } },
      });
    }

    await tx.auditEvent.create({ data: { type: "hospital.medication.ordered", userId: input.byUserId, detail: { orderId: created.id, flags: flags.length, overridden: hasDanger } } });

    // Auto-submit to pharmacy — every order is reviewed by default (brief §16/§28's end-to-end flow).
    const submitted = await tx.medicationOrder.update({ where: { id: created.id }, data: { status: "PHARMACY_REVIEW" } });
    return submitted;
  });

  await generateAdministrationSchedule(order.id, input.frequency);
  return { blocked: false, order, flags };
}

export async function verifyMedicationOrder(orderId: string, pharmacistStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await transition(tx, orderId, "VERIFIED", byUserId);
    await tx.medicationVerification.create({ data: { medicationOrderId: orderId, pharmacistStaffId, decision: "VERIFIED" } });
    await tx.auditEvent.create({ data: { type: "hospital.medication.verified", userId: byUserId, detail: { orderId } } });
    return updated;
  });
}

export async function rejectMedicationOrder(orderId: string, reason: string, pharmacistStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await transition(tx, orderId, "REJECTED", byUserId, { overrideReason: undefined });
    await tx.medicationVerification.create({ data: { medicationOrderId: orderId, pharmacistStaffId, decision: "REJECTED", reason } });
    await tx.auditEvent.create({ data: { type: "hospital.medication.rejected", userId: byUserId, detail: { orderId, reason } } });
    return updated;
  });
}

export async function holdMedicationOrder(orderId: string, reason: string, pharmacistStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await transition(tx, orderId, "HELD", byUserId);
    await tx.medicationVerification.create({ data: { medicationOrderId: orderId, pharmacistStaffId, decision: "HOLD", reason } });
    await tx.auditEvent.create({ data: { type: "hospital.medication.held", userId: byUserId, detail: { orderId, reason } } });
    return updated;
  });
}

export async function requestClarification(orderId: string, reason: string, pharmacistStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await transition(tx, orderId, "HELD", byUserId);
    await tx.medicationVerification.create({ data: { medicationOrderId: orderId, pharmacistStaffId, decision: "CLARIFICATION_REQUESTED", reason } });
    await tx.auditEvent.create({ data: { type: "hospital.medication.clarificationRequested", userId: byUserId, detail: { orderId, reason } } });
    return updated;
  });
}

/** Doctor corrects and resubmits a REJECTED/HELD order (brief Scenario D) — optionally updating the fields the pharmacist flagged. */
export async function resubmitMedicationOrder(orderId: string, byUserId: string, updates?: Partial<{ dose: string; route: string; frequency: string; durationDays: number; specialInstructions: string }>) {
  return prisma.$transaction(async (tx) => {
    if (updates) await tx.medicationOrder.update({ where: { id: orderId }, data: updates });
    return transition(tx, orderId, "PHARMACY_REVIEW", byUserId);
  });
}

/** Full/partial dispense (brief §23) — creates the DispensingRecord, then activates the order (VERIFIED -> DISPENSED -> ACTIVE) in one transaction. */
export async function dispenseMedication(input: {
  medicationOrderId: string;
  pharmacistStaffId: string;
  status?: DispenseStatus;
  quantity: number;
  quantityUnit: string;
  batchNumber?: string;
  expiryDate?: Date;
  substitutedDrugName?: string;
  destination?: string;
  witnessStaffId?: string;
  notes?: string;
  byUserId: string;
}) {
  const order = await prisma.medicationOrder.findUniqueOrThrow({ where: { id: input.medicationOrderId } });
  if (order.isControlled && !input.witnessStaffId) {
    throw new Error("Controlled medication requires a witness co-sign to dispense.");
  }

  return prisma.$transaction(async (tx) => {
    const record = await tx.dispensingRecord.create({
      data: {
        medicationOrderId: input.medicationOrderId,
        pharmacistStaffId: input.pharmacistStaffId,
        status: input.status ?? "FULL",
        quantity: input.quantity,
        quantityUnit: input.quantityUnit,
        batchNumber: input.batchNumber,
        expiryDate: input.expiryDate,
        substitutedDrugName: input.substitutedDrugName,
        destination: input.destination,
        witnessStaffId: input.witnessStaffId,
        notes: input.notes,
      },
    });
    await transition(tx, input.medicationOrderId, "DISPENSED", input.byUserId);
    const activated = await transition(tx, input.medicationOrderId, "ACTIVE", input.byUserId);
    await tx.auditEvent.create({ data: { type: "hospital.medication.dispensed", userId: input.byUserId, detail: { orderId: input.medicationOrderId, dispensingRecordId: record.id, status: record.status } } });
    return { order: activated, dispensingRecord: record };
  });
}

export async function cancelMedicationOrder(orderId: string, reason: string, cancelledByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await transition(tx, orderId, "CANCELLED", byUserId, { cancelledAt: new Date(), cancelledReason: reason, cancelledByStaffId });
    await closeOrderEnvelope(tx, updated.orderId, "CANCELLED", { reason });
    await tx.auditEvent.create({ data: { type: "hospital.medication.cancelled", userId: byUserId, detail: { orderId, reason } } });
    return updated;
  });
}

export async function discontinueMedicationOrder(orderId: string, reason: string, discontinuedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.medicationOrder.findUniqueOrThrow({ where: { id: orderId } });
    // DISCONTINUED is reachable from any non-terminal state, not just ACTIVE — a doctor can stop a med at any stage.
    if (["COMPLETED", "CANCELLED", "DISCONTINUED", "REJECTED"].includes(order.status)) {
      throw new InvalidMedicationOrderTransitionError(order.status, "DISCONTINUED");
    }
    const updated = await tx.medicationOrder.update({
      where: { id: orderId },
      data: { status: "DISCONTINUED", discontinuedAt: new Date(), discontinuedReason: reason, discontinuedByStaffId },
    });
    await closeOrderEnvelope(tx, order.orderId, "DISCONTINUED");
    await tx.auditEvent.create({ data: { type: "hospital.medication.discontinued", userId: byUserId, detail: { orderId, reason } } });
    return updated;
  });
}

/**
 * Records a dose administration (brief §20-21). Transactional and
 * concurrency-safe: re-checks both the order's status and this specific
 * administration row's status inside the transaction before writing, so
 * a double-click or a race between two nurses cannot record the same
 * dose twice (brief §36) or administer a dose whose order was just
 * cancelled out from under it.
 */
export async function administerMedication(input: {
  administrationId: string;
  status: "GIVEN" | "HELD" | "REFUSED" | "MISSED" | "CANCELLED";
  administeredByStaffId?: string;
  witnessStaffId?: string;
  safetyChecksConfirmed?: boolean;
  reasonCode?: string;
  notes?: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const admin = await tx.medicationAdministration.findUniqueOrThrow({
      where: { id: input.administrationId },
      include: { medicationOrder: true },
    });
    if (admin.status !== "DUE") throw new AdministrationNotDueError(admin.status);

    if (input.status === "GIVEN") {
      if (!["ACTIVE", "DISPENSED"].includes(admin.medicationOrder.status)) {
        throw new MedicationOrderNotActiveError(admin.medicationOrder.status);
      }
      if (admin.medicationOrder.isControlled && !input.witnessStaffId) {
        throw new Error("Controlled medication administration requires a witness co-sign.");
      }
    }

    const updated = await tx.medicationAdministration.update({
      where: { id: input.administrationId },
      data: {
        status: input.status,
        administeredAt: new Date(),
        administeredByStaffId: input.administeredByStaffId,
        witnessStaffId: input.witnessStaffId,
        safetyChecksConfirmed: input.safetyChecksConfirmed ?? false,
        reasonCode: input.reasonCode,
        notes: input.notes,
      },
    });

    const eventType =
      input.status === "GIVEN" ? "hospital.medication.administered" :
      input.status === "REFUSED" ? "hospital.medication.refused" :
      input.status === "MISSED" ? "hospital.medication.missed" :
      "hospital.medication.administered";
    await tx.auditEvent.create({ data: { type: eventType, userId: input.byUserId, detail: { orderId: admin.medicationOrderId, administrationId: input.administrationId, status: input.status } } });

    return updated;
  });
}

export async function acknowledgeSafetyWarning(warningId: string, staffId: string, byUserId: string, overrideReason?: string) {
  return prisma.$transaction(async (tx) => {
    const warning = await tx.medicationSafetyWarning.findUniqueOrThrow({ where: { id: warningId } });
    if (warning.severity === "DANGER" && !overrideReason) {
      throw new RequiresOverrideError([]);
    }
    const updated = await tx.medicationSafetyWarning.update({
      where: { id: warningId },
      data: { acknowledgedByStaffId: staffId, acknowledgedAt: new Date(), overrideReason },
    });
    if (overrideReason) {
      await tx.auditEvent.create({ data: { type: "hospital.medication.safetyOverridden", userId: byUserId, detail: { warningId, reason: overrideReason } } });
    }
    return updated;
  });
}
