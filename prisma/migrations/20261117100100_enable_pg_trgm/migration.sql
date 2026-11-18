-- RAG Phase 1: trigram matching for Indic inflection and transliterated
-- spellings (docs/RAG_AUDIT.md §11: word similarity 0.50–0.89 for true
-- variants, 0.00 for unrelated words). Migrations own every extension, in
-- "public" (ADR 0002; never from the Supabase dashboard).
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
