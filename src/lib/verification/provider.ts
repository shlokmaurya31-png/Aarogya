/**
 * Verification document storage boundary. Documents (student ID cards,
 * enrollment letters) are sensitive — they must never be reachable from a
 * public route, never appear in a student's own profile response, and never
 * be usable as model training data. This interface lets the mock local-disk
 * implementation be swapped for a real secure object store (S3 + KMS, etc.)
 * without touching any calling code. See docs/CLINICAL_EDUCATION_PRIVACY.md §4.
 */
import { createHash } from "crypto";
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";

export interface StoredDocument {
  storageRef: string;
  sha256: string;
}

export interface VerificationProvider {
  store(studentProfileId: string, kind: string, bytes: Buffer, originalName: string): Promise<StoredDocument>;
  read(storageRef: string): Promise<Buffer>;
  delete(storageRef: string): Promise<void>;
}

const UPLOAD_ROOT = path.join(process.cwd(), ".data", "verification-uploads");

/**
 * Writes to a local, gitignored directory outside of `public/` — never
 * served by a Next.js route, and never joined into the ClinicalCase table
 * a student can query. Real deployments should replace this with a private
 * object-store adapter with its own access-logged retrieval path.
 */
export class MockVerificationProvider implements VerificationProvider {
  async store(studentProfileId: string, kind: string, bytes: Buffer, originalName: string): Promise<StoredDocument> {
    await mkdir(UPLOAD_ROOT, { recursive: true });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const safeExt = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10) || ".bin";
    const filename = `${studentProfileId}-${kind}-${sha256.slice(0, 16)}${safeExt}`;
    const storageRef = path.join(UPLOAD_ROOT, filename);
    await writeFile(storageRef, bytes);
    return { storageRef, sha256 };
  }

  async read(storageRef: string): Promise<Buffer> {
    if (!storageRef.startsWith(UPLOAD_ROOT)) {
      throw new Error("Refusing to read outside the restricted verification-upload store.");
    }
    return readFile(storageRef);
  }

  async delete(storageRef: string): Promise<void> {
    if (!storageRef.startsWith(UPLOAD_ROOT)) {
      throw new Error("Refusing to delete outside the restricted verification-upload store.");
    }
    await unlink(storageRef).catch(() => undefined);
  }
}

/**
 * Documented, not implemented: what a real institutional/manual review
 * adapter would need. A future implementer replaces MockVerificationProvider
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
  if (!cached) cached = new MockVerificationProvider();
  return cached;
}
