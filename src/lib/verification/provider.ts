/**
 * Verification document storage boundary. Documents (student ID cards,
 * enrollment letters) are sensitive — they must never be reachable from a
 * public route, never appear in a student's own profile response, and never
 * be usable as model training data. See docs/CLINICAL_EDUCATION_PRIVACY.md §4.
 *
 * Stored through the object-storage adapter (src/lib/storage) in the private
 * `verification` bucket, scoped by student profile: local disk in dev, S3 /
 * Supabase Storage when STORAGE_S3_* is set (ADR 0003). The bucket's policy
 * applies to every upload: PDF/JPEG/PNG/WebP only, the content must match the
 * declared type (magic bytes), 15 MB maximum.
 *
 * `storageRef` is the adapter's logical ref (`verification/<profile>/<sha16>-
 * <name>`), never a filesystem path. Reads and deletes refuse any ref outside
 * the `verification` bucket — including the absolute paths the old local-disk
 * store persisted (scripts/migrate-verification-uploads.ts moves those).
 */
import { getStorageAdapter, assertSafeRef, StorageRefError } from "@/lib/storage";

export interface StoredDocument {
  storageRef: string;
  sha256: string;
}

export interface VerificationProvider {
  store(studentProfileId: string, kind: string, bytes: Buffer, originalName: string, contentType: string): Promise<StoredDocument>;
  read(storageRef: string): Promise<Buffer>;
  delete(storageRef: string): Promise<void>;
}

/** Throws unless `storageRef` is a logical ref in the verification bucket. */
export function assertVerificationRef(storageRef: string): void {
  if (assertSafeRef(storageRef) !== "verification") {
    throw new StorageRefError(`Not a verification-document ref: ${storageRef}`);
  }
}

export class StorageVerificationProvider implements VerificationProvider {
  async store(studentProfileId: string, kind: string, bytes: Buffer, originalName: string, contentType: string): Promise<StoredDocument> {
    const stored = await getStorageAdapter().put({
      bucket: "verification",
      bytes,
      contentType,
      originalName: `${kind.toLowerCase()}-${originalName}`,
      scope: studentProfileId,
    });
    return { storageRef: stored.storageRef, sha256: stored.sha256 };
  }

  async read(storageRef: string): Promise<Buffer> {
    assertVerificationRef(storageRef);
    return (await getStorageAdapter().get(storageRef)).bytes;
  }

  async delete(storageRef: string): Promise<void> {
    assertVerificationRef(storageRef);
    await getStorageAdapter().delete(storageRef);
  }
}

/**
 * Documented, not implemented: what a real institutional/manual review
 * adapter would need. A future implementer replaces StorageVerificationProvider
 * with something like this, backed by an actual reviewer queue and
 * retention policy — see docs/CLINICAL_EDUCATION_PRIVACY.md.
 */
export class ManualVerificationProviderStub implements VerificationProvider {
  async store(): Promise<StoredDocument> {
    throw new Error("ManualVerificationProviderStub is documentation only — not implemented.");
  }
  async read(): Promise<Buffer> {
    throw new Error("ManualVerificationProviderStub is documentation only — not implemented.");
  }
  async delete(): Promise<void> {
    throw new Error("ManualVerificationProviderStub is documentation only — not implemented.");
  }
}

let cached: VerificationProvider | null = null;
export function getVerificationProvider(): VerificationProvider {
  if (!cached) cached = new StorageVerificationProvider();
  return cached;
}
