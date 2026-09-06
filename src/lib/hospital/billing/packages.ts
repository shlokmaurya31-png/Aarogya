import { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { createChargeIfNotExists } from "./chargeCapture";

type Tx = Prisma.TransactionClient;

/** Foundation only (brief's explicit "do not build a massive package-management system") — see PackageDefinition's schema doc comment. */
export async function createPackageDefinition(
  tx: Tx,
  input: {
    facilityId: string;
    code: string;
    name: string;
    description?: string;
    packagePriceMinor: number;
    items: { chargeCode: string; description: string; quantity?: number; refUnitPriceMinor: number }[];
  }
) {
  if (input.packagePriceMinor <= 0) throw new BadRequestError("packagePriceMinor must be positive.");
  return tx.packageDefinition.create({
    data: {
      facilityId: input.facilityId,
      code: input.code,
      name: input.name,
      description: input.description,
      packagePriceMinor: input.packagePriceMinor,
      items: { create: input.items.map((item) => ({ chargeCode: item.chargeCode, description: item.description, quantity: item.quantity ?? 1, refUnitPriceMinor: item.refUnitPriceMinor })) },
    },
    include: { items: true },
  });
}

/**
 * Applies a package as exactly ONE lump Charge — no auto-explosion into
 * per-item charges, no consumption-matching engine (see PackageDefinition's
 * schema doc comment). Idempotent per (packageId, encounterId) pair via
 * the existing sourceType/sourceId charge-capture mechanism.
 */
export async function applyPackageToEncounter(
  tx: Tx,
  input: { packageId: string; encounterId: string; patientId: string; facilityId: string; postedByUserId: string }
) {
  const pkg = await tx.packageDefinition.findUniqueOrThrow({ where: { id: input.packageId } });
  if (!pkg.active) throw new BadRequestError("This package is not active.");

  return createChargeIfNotExists(tx, {
    encounterId: input.encounterId,
    patientId: input.patientId,
    facilityId: input.facilityId,
    description: `Package: ${pkg.name}`,
    category: "PACKAGE",
    chargeCode: pkg.code,
    unitPriceMinor: pkg.packagePriceMinor,
    currency: pkg.currency,
    sourceType: "PackageApplication",
    sourceId: `${pkg.id}:${input.encounterId}`,
    postedByUserId: input.postedByUserId,
  });
}
