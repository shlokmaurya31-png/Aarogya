/**
 * Phase 0 — the PERSON tenancy segment (docs/PERSON_IDENTITY_DESIGN.md §8.1).
 *
 * Person-scoped models belong to a Person, not to a facility: they carry a
 * personId (or are the Person) and no facilityId or organizationId. They are
 * read only through personAccess() (access.ts), never by a personId taken from
 * a request. Models that carry a personId but belong to a facility (the link,
 * the facility's link request, the outbox) are listed separately: their
 * facility owns them and the facility tenancy rules apply.
 *
 * tenancy.test.ts checks this against the schema, and the tenancy sweep and
 * the person leak gate use it.
 */
export const PERSON_SCOPED_MODELS = [
  "Person",
  "PersonAccount",
  "PersonContact",
  "PersonIdentifier",
  "PersonAccessLogEntry",
  "PersonConsent",
  "PersonMergeRequest",
  "PersonMergeRecord",
  "PersonDocument",
  // Week 4a — the document pipeline.
  "DocumentProcessing",
  "DocumentProcessingStep",
  "DocumentPage",
  "ExtractedText",
  "Translation",
  "ExtractedFact",
  "PatientProvidedRecord",
  // Week 4c — consent sharing.
  "RecordShare",
  "AccessRequest",
  "PersonNotification",
  // Week 5a — a booking made through the doctor directory (the appointment itself is the facility's).
  "DirectoryBooking",
] as const;

/** Facility-owned models that reference a Person. */
export const FACILITY_MODELS_WITH_PERSON = [
  "PersonPatientLink",
  "PatientLinkRequest",
  "DomainEventOutbox",
  // Patient uploads are still ClinicalDocument rows in part 1 (their facility
  // stores them); personId is the owner, and staff reads go through
  // staffDocumentVisibility(). Part 2 moves them to a person-level model.
  "ClinicalDocument",
  // Week 4a: a conflict between a person's record and a facility's verified one.
  "RecordConflict",
] as const;

/**
 * Week 4b — models owned either by a facility record or by a Person, row by
 * row (ownerType, with CHECK constraints): the AI index and AI interactions.
 * A FACILITY_PATIENT row is the facility's; a PERSON row belongs to no tenant
 * and is read only through the access resolver, like the person-scoped models.
 */
export const MIXED_OWNER_MODELS = [
  "RagDocument",
  "RagChunk",
  "RagEmbedding",
  "AiInteraction",
] as const;
