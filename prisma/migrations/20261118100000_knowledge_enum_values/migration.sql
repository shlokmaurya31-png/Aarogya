-- RAG Phase 2: enum values only, ahead of anything that uses them (docs/RAG_IMPLEMENTATION_PLAN.md §1).
-- Decided 2026-11-18 (§13.3 A): two staff roles that approve knowledge documents.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MEDICAL_SUPERINTENDENT';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'QUALITY_LEAD';
-- Why a knowledge version's index rows left the search: withdrawn, expired or rejected.
ALTER TYPE "RagWithdrawReason" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_WITHDRAWN';
ALTER TYPE "RagWithdrawReason" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_EXPIRED';
ALTER TYPE "RagWithdrawReason" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_REJECTED';
