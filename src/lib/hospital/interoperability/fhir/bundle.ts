import { createHash } from "crypto";
import { FHIR_VERSION } from "./types";
import type { FhirBundle, FhirBundleEntry, FhirResource, FhirComposition, FhirReference } from "./types";

/**
 * Phase C1 — FHIR Bundle construction.
 *
 * This is NOT a FHIR server. It composes Bundles from canonical records for a
 * specific, authorized export and nothing else: there is no persistence, no
 * search, no REST capability statement.
 *
 * The ABDM IG exchanges health records as a DocumentBundle — a Bundle of type
 * `document` whose FIRST entry is a Composition that indexes the rest. That
 * shape is what buildDocumentBundle produces.
 */

/** ABDM health-record artefact types (Composition-based) that C1 can compose. */
export const DOCUMENT_BUNDLE_TYPES = {
  OP_CONSULT: { code: "371530004", display: "Clinical consultation report", title: "OP Consult Record" },
  DISCHARGE_SUMMARY: { code: "373942005", display: "Discharge summary", title: "Discharge Summary" },
  DIAGNOSTIC_REPORT: { code: "721981007", display: "Diagnostic studies report", title: "Diagnostic Report" },
  PRESCRIPTION: { code: "440545006", display: "Prescription record", title: "Prescription Record" },
  HEALTH_DOCUMENT: { code: "419891008", display: "Record artifact", title: "Health Document Record" },
} as const;

export type DocumentBundleType = keyof typeof DOCUMENT_BUNDLE_TYPES;

function fullUrl(resource: FhirResource): string {
  // urn:uuid is the conventional fullUrl for a document bundle whose resources
  // have no externally resolvable REST endpoint — which is exactly our case,
  // since Aarogya exposes no FHIR read API.
  return `urn:uuid:${resource.id}`;
}

function refTo(resource: FhirResource): FhirReference {
  return { reference: `${resource.resourceType}/${resource.id}` };
}

export interface DocumentBundleInput {
  bundleType: DocumentBundleType;
  /** Stable identifier for this document, derived from the exchange. */
  bundleId: string;
  /** Composition.date and Bundle.timestamp. Passed in, never Date.now(), so bundles are reproducible. */
  timestamp: Date;
  subject: FhirResource;
  author: FhirResource;
  custodian?: FhirResource;
  encounter?: FhirResource;
  sections: { title: string; resources: FhirResource[] }[];
}

/**
 * Compose a DocumentBundle.
 *
 * Deterministic by construction: the caller supplies the timestamp and ids, and
 * resources are emitted in the order given. The same inputs always produce a
 * byte-identical bundle, which is what makes `hashBundle` meaningful as proof of
 * what was exchanged.
 */
export function buildDocumentBundle(input: DocumentBundleInput): FhirBundle {
  const sections = input.sections.filter((s) => s.resources.length > 0);
  const meta = DOCUMENT_BUNDLE_TYPES[input.bundleType];

  const composition: FhirComposition = {
    resourceType: "Composition",
    id: `composition-${input.bundleId}`,
    status: "final",
    type: { coding: [{ system: "http://snomed.info/sct", code: meta.code, display: meta.display }], text: meta.title },
    subject: refTo(input.subject),
    ...(input.encounter ? { encounter: refTo(input.encounter) } : {}),
    date: input.timestamp.toISOString(),
    author: [refTo(input.author)],
    title: meta.title,
    ...(input.custodian ? { custodian: refTo(input.custodian) } : {}),
    section: sections.map((s) => ({ title: s.title, entry: s.resources.map(refTo) })),
  };

  // Composition MUST be the first entry of a document Bundle.
  const ordered: FhirResource[] = [composition, input.subject, input.author];
  if (input.custodian) ordered.push(input.custodian);
  if (input.encounter) ordered.push(input.encounter);
  for (const s of sections) ordered.push(...s.resources);

  // De-duplicate by resourceType/id — a practitioner or encounter referenced
  // from several sections must appear exactly once in the bundle.
  const seen = new Set<string>();
  const entry: FhirBundleEntry[] = [];
  for (const resource of ordered) {
    const key = `${resource.resourceType}/${resource.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entry.push({ fullUrl: fullUrl(resource), resource });
  }

  return {
    resourceType: "Bundle",
    id: input.bundleId,
    meta: { lastUpdated: input.timestamp.toISOString(), source: `Aarogya/FHIR-${FHIR_VERSION}` },
    identifier: { system: "https://aarogya.local/bundle", value: input.bundleId },
    type: "document",
    timestamp: input.timestamp.toISOString(),
    total: entry.length,
    entry,
  };
}

/** A plain collection Bundle, for exports that are not a clinical document. */
export function buildCollectionBundle(bundleId: string, timestamp: Date, resources: FhirResource[]): FhirBundle {
  const seen = new Set<string>();
  const entry: FhirBundleEntry[] = [];
  for (const resource of resources) {
    const key = `${resource.resourceType}/${resource.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entry.push({ fullUrl: fullUrl(resource), resource });
  }
  return {
    resourceType: "Bundle",
    id: bundleId,
    meta: { lastUpdated: timestamp.toISOString(), source: `Aarogya/FHIR-${FHIR_VERSION}` },
    type: "collection",
    timestamp: timestamp.toISOString(),
    total: entry.length,
    entry,
  };
}

/**
 * Stable hash of a bundle. Keys are sorted so that an equivalent bundle always
 * hashes identically regardless of property insertion order, which lets an
 * exchange prove exactly what it transmitted without storing the payload.
 */
export function hashBundle(bundle: FhirBundle): string {
  const canonical = JSON.stringify(bundle, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function countResources(bundle: FhirBundle): number {
  return bundle.entry?.length ?? 0;
}
