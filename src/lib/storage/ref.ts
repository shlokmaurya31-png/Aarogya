/**
 * Phase 1.1 — storageRef construction and validation.
 *
 * A storageRef is a logical key, never a filesystem path:
 *   `<bucket>/<scope?>/<sha16>-<safeName>`
 * The bucket segment must be a known bucket and no segment may traverse (`..`,
 * absolute paths, backslashes). Both adapters map the same ref consistently.
 */
import { STORAGE_BUCKETS, StorageRefError, type StorageBucket } from "./types";
import { safeName, safeScope } from "./validation";

export function buildRef(bucket: StorageBucket, sha256: string, originalName: string, scope?: string): string {
  const scopeSeg = safeScope(scope);
  const name = safeName(originalName);
  const shaSeg = sha256.slice(0, 16);
  return [bucket, scopeSeg, `${shaSeg}-${name}`].filter(Boolean).join("/");
}

/** Validate a ref and return its bucket, or throw StorageRefError. */
export function assertSafeRef(storageRef: string): StorageBucket {
  if (!storageRef || storageRef.includes("\\") || storageRef.includes("..") || storageRef.startsWith("/")) {
    throw new StorageRefError(`Unsafe storageRef: ${storageRef}`);
  }
  const bucket = storageRef.split("/")[0];
  if (!STORAGE_BUCKETS.includes(bucket as StorageBucket)) {
    throw new StorageRefError(`Unknown storage bucket in ref: ${storageRef}`);
  }
  return bucket as StorageBucket;
}
