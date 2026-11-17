-- RAG Phase 1 (docs/RAG_IMPLEMENTATION_PLAN.md §3, ADR 0005 part B): new enum
-- values, in a migration of their own. A value added to a Postgres enum
-- cannot be used in the transaction that adds it, so the CHECKs and columns
-- that use these come in later migrations.

-- An approved knowledge document of an organisation: no patient, no person.
ALTER TYPE "RagOwnerType" ADD VALUE 'KNOWLEDGE';
-- Brought from the hospital's previous system: never a verified fact; staff only.
ALTER TYPE "RagOrigin" ADD VALUE 'IMPORTED';
ALTER TYPE "RagSourceType" ADD VALUE 'KNOWLEDGE_DOCUMENT';
ALTER TYPE "RagSourceType" ADD VALUE 'LEGACY_LAB_RESULT';
-- Written, not yet published: never a retrieval candidate (retrieval admits ACTIVE only).
ALTER TYPE "RagDocumentStatus" ADD VALUE 'PENDING';
