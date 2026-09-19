/**
 * Phase D9 — workflow builder public surface. The builder authors the SAME canonical
 * D7 workflow definition D7 executes and D8 governs; it is not a new engine. See
 * docs/platform/workflow-builder/.
 */
export { parseBuilderDocument, BuilderDocumentSchema, MAX_DOCUMENT_BYTES, type BuilderDocument } from "./document";
export { compileBuilderDocument, buildValidationReport, diffConfigs, BuilderIncompleteError, type ValidationReport, type ConfigDiff } from "./compile";
export { simulateWorkflow, type SimulationResult, type SimulateInput } from "./simulate";
export { builderMetadata } from "./metadata";
export { WORKFLOW_TEMPLATES, listTemplates, getTemplate, type WorkflowTemplate } from "./templates";
export { saveDraft, getDraft, listDrafts, deleteDraft, publishDraft, importWorkflow, exportWorkflow } from "./drafts";
