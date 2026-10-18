import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AiDataOwner } from "@/lib/ai/realData";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Week 4b — removing an owner's index (docs/RAG_DESIGN.md §4.1–§4.2). The
 * index is derived data, so removal is a hard delete of the documents (their
 * chunks and embeddings go with them); the record itself is untouched and
 * the index can be rebuilt. Used when the AI gate refuses an owner (consent
 * withdrawn or lapsed past its window, account closed, erasure): the index
 * never holds data the AI may not use.
 */
export async function removeOwnerIndex(db: Db, owner: AiDataOwner): Promise<number> {
  const where: Prisma.RagDocumentWhereInput = "personId" in owner
    ? { ownerType: "PERSON", personId: owner.personId }
    : { ownerType: "FACILITY_PATIENT", facilityId: owner.facilityId, patientId: owner.patientId };
  return (await db.ragDocument.deleteMany({ where })).count;
}
