/**
 * Phase 1.1 — storage entry point.
 *
 * getStorageAdapter() selects S3 when STORAGE_S3_* credentials exist, otherwise
 * the always-available local-disk adapter. Everything else in the codebase
 * depends only on this and the StorageAdapter interface.
 */
import type { StorageAdapter } from "./types";
import { LocalDiskStorageAdapter } from "./localAdapter";
import { S3StorageAdapter, readS3ConfigFromEnv } from "./s3Adapter";

export * from "./types";
export { validateUpload, sniffContentType, maxSizeForBucket, allowedTypesForBucket } from "./validation";
export { verifyDownloadToken } from "./token";
export { assertSafeRef } from "./ref";

let cached: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (cached) return cached;
  const s3 = readS3ConfigFromEnv();
  cached = s3 ? new S3StorageAdapter(s3) : new LocalDiskStorageAdapter();
  return cached;
}

/** Which adapter is active, for diagnostics/health endpoints. */
export function activeStorageProviderName(): string {
  return getStorageAdapter().name;
}

/** Test-only: drop the cached adapter so env changes take effect. */
export function __resetStorageAdapterForTests(): void {
  cached = null;
}
