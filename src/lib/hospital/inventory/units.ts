import type { UnitOfMeasure } from "@prisma/client";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Minimum reliable unit-conversion foundation (brief: "not a giant
 * conversion engine"). Every unit belongs to exactly one dimension group;
 * conversion is only ever attempted within the same group, and an
 * item-scoped ItemUnitConversion row supplies the actual factor (e.g. 1
 * BOX = 100 TABLET is specific to one item, not a global constant).
 */
const DIMENSION_GROUP: Record<UnitOfMeasure, "COUNT" | "MASS" | "VOLUME" | "OTHER"> = {
  TABLET: "COUNT",
  CAPSULE: "COUNT",
  VIAL: "COUNT",
  AMPOULE: "COUNT",
  BOTTLE: "COUNT",
  BOX: "COUNT",
  PACK: "COUNT",
  PIECE: "COUNT",
  MG: "MASS",
  GRAM: "MASS",
  KG: "MASS",
  ML: "VOLUME",
  LITER: "VOLUME",
  OTHER: "OTHER",
};

export class IncompatibleUnitError extends Error {
  constructor(from: UnitOfMeasure, to: UnitOfMeasure) {
    super(`Cannot convert ${from} to ${to} — incompatible units. Never silently converted.`);
  }
}

export class UnitConversionNotConfiguredError extends Error {
  constructor(itemId: string, unit: UnitOfMeasure) {
    super(`No conversion configured for item ${itemId} in unit ${unit}.`);
  }
}

export function unitsAreCompatible(a: UnitOfMeasure, b: UnitOfMeasure): boolean {
  if (a === b) return true;
  if (DIMENSION_GROUP[a] === "OTHER" || DIMENSION_GROUP[b] === "OTHER") return false;
  return DIMENSION_GROUP[a] === DIMENSION_GROUP[b];
}

/**
 * Converts a quantity expressed in `fromUnit` into the item's `baseUnit`.
 * Throws rather than guessing when units are dimensionally incompatible or
 * no ItemUnitConversion row exists for a non-base unit — this codebase's
 * established discipline (see billing/money.ts's discount-can't-exceed-
 * gross guard) is to reject ambiguous input, never silently coerce it.
 */
export async function convertToBaseUnit(
  tx: Tx,
  item: { id: string; baseUnit: UnitOfMeasure },
  quantity: number,
  fromUnit: UnitOfMeasure
): Promise<number> {
  if (fromUnit === item.baseUnit) return quantity;
  if (!unitsAreCompatible(fromUnit, item.baseUnit)) throw new IncompatibleUnitError(fromUnit, item.baseUnit);

  const conversion = await tx.itemUnitConversion.findUnique({
    where: { itemId_unit: { itemId: item.id, unit: fromUnit } },
  });
  if (!conversion) throw new UnitConversionNotConfiguredError(item.id, fromUnit);
  return quantity * conversion.baseUnitsPerUnit;
}
