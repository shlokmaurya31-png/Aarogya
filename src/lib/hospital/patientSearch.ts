import type { Prisma } from "@prisma/client";
import { textContains } from "@/lib/search";

/**
 * Where-clause for Hospital OS patient search: facility-scoped, and when a
 * query is given, a case-insensitive match on name, UHID, phone or any
 * patient identifier (ABHA/MRN/insurance, Phase 6.8).
 */
export function patientSearchWhere(facilityId: string, q?: string): Prisma.PatientWhereInput {
  return {
    facilityId,
    ...(q
      ? {
          OR: [
            { fullName: textContains(q) },
            { uhid: textContains(q) },
            { phone: textContains(q) },
            { identifiers: { some: { value: textContains(q) } } },
          ],
        }
      : {}),
  };
}
