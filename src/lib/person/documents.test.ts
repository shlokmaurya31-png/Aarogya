import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { CLINICAL_DOCUMENT_REFERENCES } from "./documents";

describe("the upload move knows every column that can point at a ClinicalDocument", () => {
  it("lists every model with a documentId column (besides the document stores themselves)", () => {
    const withDocumentId = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === "documentId" && f.kind === "scalar"))
      .map((m) => m.name)
      // These documentId columns point at a PersonDocument, never a ClinicalDocument;
      // RagChunk's points at its RagDocument (the AI index's own row); KnowledgeDocumentVersion's
      // at its KnowledgeDocument (RAG Phase 1; a foreign key to that table only).
      .filter((m) => !["DocumentProcessing", "PatientProvidedRecord", "RagChunk", "KnowledgeDocumentVersion"].includes(m))
      .sort();
    expect(withDocumentId).toEqual([...CLINICAL_DOCUMENT_REFERENCES].sort());
  });
});
