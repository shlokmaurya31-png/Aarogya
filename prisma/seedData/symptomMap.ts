import type { PrismaClient } from "@prisma/client";
import { SYMPTOM_SEED } from "../../src/lib/doctors/vocab";

/**
 * Week 5a — the symptom → specialty map, version 1 (~50 symptoms). Every row
 * is PENDING_CLINICAL_ADVISOR until a named clinical advisor signs it off
 * (docs/PRE_LAUNCH_CHECKLIST.md item 2). Idempotent: an existing version 1 is
 * left as it is.
 */
export async function seedSymptomMap(prisma: PrismaClient) {
  if (await prisma.symptomSpecialtyMap.count({ where: { version: 1 } })) return;
  await prisma.symptomSpecialtyMap.createMany({
    data: SYMPTOM_SEED.flatMap((s) => s.specialties.map((specialty, i) => ({ symptomCode: s.code, label: s.label, specialty, weight: s.specialties.length - i, version: 1 }))),
  });
}
