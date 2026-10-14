import type { Prisma } from "@prisma/client";
import { textContains } from "@/lib/search";

/**
 * Where-clause for Hospital OS patient search: facility-scoped, and when a
 * query is given, a case-insensitive match on name, UHID, phone or any
 * patient identifier: Aarogya-issued (MRN) or external (ABHA, insurer member
 * ID, …; D1). External identifiers are a polymorphic mapping with no relation
 * to Patient, so their matches arrive as `externalMatchIds`
 * (patientIdsByExternalIdentifier).
 */
export function patientSearchWhere(facilityId: string, q?: string, externalMatchIds: string[] = []): Prisma.PatientWhereInput {
  return {
    facilityId,
    ...(q
      ? {
          OR: [
            { fullName: textContains(q) },
            { uhid: textContains(q) },
            { phone: textContains(q) },
            { identifiers: { some: { value: textContains(q) } } },
            ...(externalMatchIds.length ? [{ id: { in: externalMatchIds } }] : []),
          ],
        }
      : {}),
  };
}
