import type { DomainEventConsumer } from "@/lib/events/consumers";
import { ingestKnowledgeVersion } from "@/lib/knowledge/ingest";

/**
 * RAG Phase 2, step 2.6 — the knowledge-ingest consumer (bulk lane: the
 * upload event is a bulk contract, so ingesting a long formulary never
 * delays a live event). Idempotent and retried by the dispatcher; see
 * src/lib/knowledge/ingest.ts.
 */
export const knowledgeIngest: DomainEventConsumer = {
  name: "knowledge-ingest",
  handles: ["KnowledgeDocumentVersionUploaded"],
  async handle(event) {
    await ingestKnowledgeVersion(String(event.payload.versionId), { eventId: event.eventId });
  },
};
