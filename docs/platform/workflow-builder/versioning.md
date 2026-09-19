# Versioning

The builder reuses D7/D8 versioning — no second version system.

- A **draft** lives in `WorkflowBuilderDraft` and may be incomplete.
- **Publishing** compiles the draft and calls D7: a brand-new workflow →
  `createDefinition` (v1) then `publishVersion`; an edit of an existing definition →
  `createVersion` (vN) then `publishVersion`. The guarded D7 promotion makes
  concurrent publishes safe (one active version).
- A published version is **immutable**; editing creates a new version. Existing
  workflow instances keep referencing the version that started them.
- **Diff** (`diffConfigs`, `POST …/workflow-builder/diff`) is a semantic,
  configuration-aware comparison (trigger change, added/removed/changed steps), not
  raw JSON text (§33), and never exposes secrets.
- **History** is available via the D7 definition's versions and the AuditEvent trail.
