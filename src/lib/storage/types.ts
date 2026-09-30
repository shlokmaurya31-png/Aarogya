/**
 * Phase 1.1 — Object storage boundary.
 *
 * A single interface every consumer (clinical documents, verification uploads,
 * generated report/invoice PDFs, patient-uploaded outside records) writes and
 * reads binary objects through. Two implementations sit behind it:
 *
 *   - LocalDiskStorageAdapter (default, always available) writes to a gitignored
 *     directory OUTSIDE public/, never served statically. Downloads go through a
 *     short-lived HMAC-signed token route so the access path is auditable.
 *   - S3StorageAdapter (S3 / Cloudflare R2 / any S3-compatible store) activates
 *     ONLY when the STORAGE_* credentials exist in the environment. Downloads use
 *     provider-native presigned URLs.
 *
 * Following the verification-provider pattern (src/lib/verification/provider.ts):
 * calling code depends on the interface only and never learns which adapter is
 * active. No adapter ever reports success for an operation it cannot perform.
 */

/**
 * Logical partitions of the object store. The bucket is the first path segment
 * of every storageRef and selects the validation policy. It is NOT necessarily a
 * physical S3 bucket — the S3 adapter maps all logical buckets into one
 * configured bucket under a key prefix.
 */
export const STORAGE_BUCKETS = [
  "clinical-documents",
  "verification",
  "reports",
  "patient-uploads",
  "generated-pdf",
] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

export interface PutObjectInput {
  bucket: StorageBucket;
  bytes: Buffer;
  /** Declared content type; cross-checked against the byte signature. */
  contentType: string;
  /** Original filename, used only to derive a safe, human-readable suffix. */
  originalName: string;
  /**
   * Optional caller-supplied scope segment (e.g. a facilityId or patientId) so
   * objects for one tenant/patient are grouped and never collide. Sanitised.
   */
  scope?: string;
}

export interface StoredObject {
  /**
   * Opaque logical reference persisted in the DB (e.g. ClinicalDocument.storageRef).
   * Shape: `<bucket>/<scope?>/<sha256-16>-<safeName>`. Never a filesystem path.
   */
  storageRef: string;
  sha256: string;
  size: number;
  contentType: string;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

export interface LoadedObject {
  bytes: Buffer;
  contentType: string;
}

export interface StorageAdapter {
  /** Human name for logs/diagnostics, e.g. "local-disk" or "s3". */
  readonly name: string;
  /** True when the adapter has everything it needs to actually operate. */
  readonly configured: boolean;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(storageRef: string): Promise<LoadedObject>;
  /** A short-lived URL a browser can GET directly. `expiresInSeconds` is clamped. */
  signedDownloadUrl(storageRef: string, expiresInSeconds?: number): Promise<SignedDownload>;
  delete(storageRef: string): Promise<void>;
}

/** Thrown when an upload fails validation (bad MIME, oversize, signature mismatch). */
export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}

/** Thrown when a storageRef is malformed or escapes its bucket. */
export class StorageRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageRefError";
  }
}
