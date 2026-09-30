/**
 * Phase 1.1 — local-disk storage adapter (default, always available).
 *
 * Writes to a gitignored directory OUTSIDE public/, so nothing is ever served
 * statically. Downloads are authorised by a short-lived HMAC token and streamed
 * through /api/storage/download, keeping every retrieval on an auditable path.
 * This is the honest dev/self-host default; production swaps in S3StorageAdapter
 * by supplying credentials, with zero calling-code changes.
 */
import { createHash } from "crypto";
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";
import {
  StorageRefError,
  type LoadedObject,
  type PutObjectInput,
  type SignedDownload,
  type StorageAdapter,
  type StoredObject,
} from "./types";
import { validateUpload } from "./validation";
import { buildRef, assertSafeRef } from "./ref";
import { createDownloadToken } from "./token";

const STORE_ROOT = path.join(process.cwd(), ".data", "object-store");

/** Map a validated logical ref to its absolute on-disk path, refusing escapes. */
function refToPath(storageRef: string): string {
  assertSafeRef(storageRef);
  const abs = path.resolve(STORE_ROOT, storageRef);
  const rootWithSep = STORE_ROOT + path.sep;
  if (abs !== STORE_ROOT && !abs.startsWith(rootWithSep)) {
    throw new StorageRefError(`Resolved path escapes the object store: ${storageRef}`);
  }
  return abs;
}

export class LocalDiskStorageAdapter implements StorageAdapter {
  readonly name = "local-disk";
  readonly configured = true;

  async put(input: PutObjectInput): Promise<StoredObject> {
    const contentType = validateUpload(input.bucket, input.bytes, input.contentType);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const storageRef = buildRef(input.bucket, sha256, input.originalName, input.scope);
    const target = refToPath(storageRef);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.bytes);
    return { storageRef, sha256, size: input.bytes.length, contentType };
  }

  async get(storageRef: string): Promise<LoadedObject> {
    const target = refToPath(storageRef);
    const bytes = await readFile(target);
    // Content type is not stored alongside the bytes on local disk; the download
    // route re-sniffs it. Callers that need it should persist it in their model.
    return { bytes, contentType: "application/octet-stream" };
  }

  async signedDownloadUrl(storageRef: string, expiresInSeconds?: number): Promise<SignedDownload> {
    assertSafeRef(storageRef);
    const { token, expiresAt } = createDownloadToken(storageRef, expiresInSeconds);
    return { url: `/api/storage/download?token=${encodeURIComponent(token)}`, expiresAt };
  }

  async delete(storageRef: string): Promise<void> {
    const target = refToPath(storageRef);
    await unlink(target).catch(() => undefined);
  }
}
