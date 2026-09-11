import { BadRequestError } from "@/lib/auth/rbac";
import { SUPPORTED_RESOURCE_TYPES, type SupportedResourceType } from "./types";

/**
 * Phase C1 — structural validation of UNTRUSTED FHIR payloads.
 *
 * Everything arriving from outside is hostile until proven otherwise. This
 * module answers only one question: is this payload structurally safe to look
 * at? It is explicitly NOT a FHIR profile validator, and it makes no claim of
 * ABDM conformance.
 *
 * The threats it exists to stop:
 *   - unbounded payloads exhausting memory
 *   - deeply nested JSON exhausting the stack
 *   - prototype pollution via __proto__ / constructor keys
 *   - unsupported or unknown resource types reaching a mapper
 *   - references that do not even have the shape of a reference
 *   - meta/security fields being mistaken for authorization
 */

/** Hard ceilings. Generous enough for a real discharge summary, bounded enough to be safe. */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_BUNDLE_ENTRIES = 500;
export const MAX_JSON_DEPTH = 32;

export class FhirValidationError extends BadRequestError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`FHIR payload rejected: ${issues.join("; ")}`);
    this.issues = issues;
  }
}

/** Keys that must never appear in parsed external JSON. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertDepthAndKeys(value: unknown, depth = 0, issues: string[] = []): string[] {
  if (depth > MAX_JSON_DEPTH) {
    issues.push(`payload nests deeper than ${MAX_JSON_DEPTH} levels`);
    return issues;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      assertDepthAndKeys(v, depth + 1, issues);
      if (issues.length) return issues;
    }
    return issues;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        issues.push(`payload contains a forbidden key: ${key}`);
        return issues;
      }
      assertDepthAndKeys((value as Record<string, unknown>)[key], depth + 1, issues);
      if (issues.length) return issues;
    }
  }
  return issues;
}

/**
 * Parse a raw external body safely. Takes the RAW STRING so the size limit is
 * applied before any parsing work happens.
 */
export function parseFhirPayload(raw: string): unknown {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes === 0) throw new FhirValidationError(["payload is empty"]);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new FhirValidationError([`payload is ${bytes} bytes, limit is ${MAX_PAYLOAD_BYTES}`]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FhirValidationError(["payload is not valid JSON"]);
  }
  const issues = assertDepthAndKeys(parsed);
  if (issues.length) throw new FhirValidationError(issues);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FhirValidationError(["payload must be a FHIR resource object"]);
  }
  return parsed;
}

export interface ValidatedResource {
  resourceType: SupportedResourceType;
  id?: string;
  raw: Record<string, unknown>;
}

export function validateResource(value: unknown): ValidatedResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FhirValidationError(["resource must be an object"]);
  }
  const obj = value as Record<string, unknown>;
  const resourceType = obj.resourceType;
  if (typeof resourceType !== "string" || !resourceType) {
    throw new FhirValidationError(["resource is missing resourceType"]);
  }
  if (!(SUPPORTED_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
    // Named explicitly so an operator can see what was refused, but nothing
    // about the payload is echoed back.
    throw new FhirValidationError([`unsupported resourceType: ${resourceType}`]);
  }
  if (obj.id !== undefined && typeof obj.id !== "string") {
    throw new FhirValidationError(["resource id must be a string"]);
  }
  if (typeof obj.id === "string" && obj.id.length > 64) {
    throw new FhirValidationError(["resource id exceeds 64 characters"]);
  }
  return { resourceType: resourceType as SupportedResourceType, id: obj.id as string | undefined, raw: obj };
}

/** A FHIR reference must look like `ResourceType/id`. */
export function validateReference(value: unknown, label: string): { type: string; id: string } {
  if (!value || typeof value !== "object") throw new FhirValidationError([`${label} is missing`]);
  const reference = (value as Record<string, unknown>).reference;
  if (typeof reference !== "string" || !reference) {
    throw new FhirValidationError([`${label} has no reference string`]);
  }
  if (reference.length > 256) throw new FhirValidationError([`${label} reference is too long`]);
  const match = /^([A-Za-z]+)\/([A-Za-z0-9._-]{1,64})$/.exec(reference);
  if (!match) throw new FhirValidationError([`${label} is not a valid relative reference`]);
  return { type: match[1], id: match[2] };
}

export function readIdentifiers(resource: Record<string, unknown>): { system: string; value: string }[] {
  const raw = resource.identifier;
  if (!Array.isArray(raw)) return [];
  const out: { system: string; value: string }[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const system = (item as Record<string, unknown>).system;
    const value = (item as Record<string, unknown>).value;
    if (typeof system === "string" && typeof value === "string" && system && value && value.length <= 128) {
      out.push({ system, value });
    }
  }
  return out;
}

export interface ValidatedBundle {
  bundleType: string;
  entries: ValidatedResource[];
}

export function validateBundle(value: unknown): ValidatedBundle {
  const resource = validateResource(value);
  if (resource.resourceType !== "Bundle") throw new FhirValidationError(["expected a Bundle"]);
  const type = resource.raw.type;
  if (typeof type !== "string") throw new FhirValidationError(["Bundle is missing type"]);
  if (!["document", "collection", "transaction", "batch"].includes(type)) {
    throw new FhirValidationError([`unsupported Bundle type: ${type}`]);
  }
  const rawEntries = resource.raw.entry;
  if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
    throw new FhirValidationError(["Bundle entry must be an array"]);
  }
  const list = (rawEntries ?? []) as unknown[];
  if (list.length > MAX_BUNDLE_ENTRIES) {
    throw new FhirValidationError([`Bundle has ${list.length} entries, limit is ${MAX_BUNDLE_ENTRIES}`]);
  }
  const entries: ValidatedResource[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") throw new FhirValidationError(["Bundle entry must be an object"]);
    const inner = (raw as Record<string, unknown>).resource;
    if (inner === undefined) continue; // request-only entries carry no resource
    entries.push(validateResource(inner));
  }
  return { bundleType: type, entries };
}

/**
 * Strip anything that could be mistaken for authorization.
 *
 * FHIR `meta.security`, `meta.tag` and `meta.profile` are metadata, NOT
 * permissions. A payload claiming a security label must never influence an
 * access decision, so the whole meta block is dropped before a resource reaches
 * any mapper or service. Authorization is decided exclusively from the
 * authenticated session, RBAC, facility scope and consent.
 */
export function stripUntrustedMeta(resource: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resource)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (key === "meta") continue;
    copy[key] = value;
  }
  return copy;
}
