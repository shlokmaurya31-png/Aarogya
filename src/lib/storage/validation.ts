/**
 * Phase 1.1 — upload validation shared by every storage adapter.
 *
 * Two independent checks, both enforced server-side before an object is written:
 *   1. Size ceiling (per bucket).
 *   2. Content-type allow-list AND a magic-byte signature that must agree with
 *      the declared type. A caller cannot smuggle an executable in by labelling
 *      it "application/pdf" — the bytes are sniffed.
 *
 * Deliberately NOT a virus scanner: real malware scanning belongs to an external
 * provider (ClamAV / a cloud AV API) wired behind its own adapter when procured.
 * This layer is the honest, always-on floor; it never claims to have scanned.
 */
import { StorageValidationError, type StorageBucket } from "./types";

const MB = 1024 * 1024;

/** Per-bucket maximum object size. */
const SIZE_LIMITS: Record<StorageBucket, number> = {
  "clinical-documents": 25 * MB,
  verification: 15 * MB,
  reports: 25 * MB,
  "patient-uploads": 20 * MB,
  "generated-pdf": 25 * MB,
};

/** Content types accepted in each bucket. */
const ALLOWED_TYPES: Record<StorageBucket, readonly string[]> = {
  "clinical-documents": ["application/pdf", "image/jpeg", "image/png", "image/webp"],
  verification: ["application/pdf", "image/jpeg", "image/png", "image/webp"],
  reports: ["application/pdf"],
  "patient-uploads": ["application/pdf", "image/jpeg", "image/png", "image/webp"],
  "generated-pdf": ["application/pdf"],
};

/**
 * Sniff the leading bytes and return the content type they represent, or null if
 * unrecognised. Only the formats we accept are recognised.
 */
export function sniffContentType(bytes: Buffer): string | null {
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) return "image/webp";
  return null;
}

export function maxSizeForBucket(bucket: StorageBucket): number {
  return SIZE_LIMITS[bucket];
}

export function allowedTypesForBucket(bucket: StorageBucket): readonly string[] {
  return ALLOWED_TYPES[bucket];
}

/**
 * Validate a candidate upload. Throws StorageValidationError on any failure;
 * returns the confirmed content type (the sniffed type, which is authoritative)
 * on success.
 */
export function validateUpload(bucket: StorageBucket, bytes: Buffer, declaredType: string): string {
  if (bytes.length === 0) throw new StorageValidationError("Empty file.");

  const limit = SIZE_LIMITS[bucket];
  if (bytes.length > limit) {
    throw new StorageValidationError(
      `File is ${(bytes.length / MB).toFixed(1)} MB; the limit for ${bucket} is ${(limit / MB).toFixed(0)} MB.`
    );
  }

  const allowed = ALLOWED_TYPES[bucket];
  const declared = declaredType.split(";")[0].trim().toLowerCase();
  if (!allowed.includes(declared)) {
    throw new StorageValidationError(`Content type "${declared}" is not allowed in ${bucket}.`);
  }

  const sniffed = sniffContentType(bytes);
  if (!sniffed) {
    throw new StorageValidationError("File type could not be recognised from its contents.");
  }
  if (sniffed !== declared) {
    throw new StorageValidationError(
      `Declared type "${declared}" does not match the file's actual contents ("${sniffed}").`
    );
  }
  if (!allowed.includes(sniffed)) {
    throw new StorageValidationError(`File contents ("${sniffed}") are not allowed in ${bucket}.`);
  }
  return sniffed;
}

/** Turn an arbitrary filename into a short, safe suffix for a storage key. */
export function safeName(originalName: string): string {
  const base = originalName.replace(/\\/g, "/").split("/").pop() ?? "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned.slice(-60) || "file";
}

/** Sanitise a caller-supplied scope segment. */
export function safeScope(scope: string | undefined): string | null {
  if (!scope) return null;
  const cleaned = scope.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}
