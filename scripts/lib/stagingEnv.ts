/**
 * Shared helpers for the staging scripts (scripts/staging.ts,
 * scripts/storage.ts). Staging credentials come ONLY from .env.staging.local
 * (gitignored); nothing here prints a secret.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..");
export const STAGING_ENV_FILE = path.join(ROOT, ".env.staging.local");

export class StagingError extends Error {}

/** Minimal .env parser: KEY=value, optional quotes, # comments. */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

export function readStagingEnvFile(): Record<string, string> {
  if (!existsSync(STAGING_ENV_FILE)) {
    throw new StagingError("Missing .env.staging.local. Create it with: cp .env.staging.example .env.staging.local, then fill in the values (docs/STAGING_SUPABASE.md).");
  }
  return readEnvFile(STAGING_ENV_FILE);
}

export const STORAGE_KEYS = [
  "STORAGE_S3_ENDPOINT",
  "STORAGE_S3_REGION",
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
  "STORAGE_S3_FORCE_PATH_STYLE",
  "STORAGE_S3_BUCKET_PER_LOGICAL",
  "STORAGE_S3_CHECKSUMS",
] as const;

/**
 * The Supabase Storage (S3 protocol) settings from .env.staging.local, validated.
 * Returns the env entries to apply and the values to scrub from any output.
 */
export function loadStagingStorage(env: Record<string, string> = readStagingEnvFile()) {
  for (const key of STORAGE_KEYS) {
    const value = env[key];
    if (!value) throw new StagingError(`${key} is not set in .env.staging.local (see .env.staging.example).`);
    if (/[<>]/.test(value)) throw new StagingError(`${key} in .env.staging.local still contains a <placeholder>.`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(env.STORAGE_S3_ENDPOINT);
  } catch {
    throw new StagingError("STORAGE_S3_ENDPOINT in .env.staging.local is not a valid URL.");
  }
  if (endpoint.protocol !== "https:" || !/\.supabase\.co$/.test(endpoint.hostname) || !/\/storage\/v1\/s3\/?$/.test(endpoint.pathname)) {
    throw new StagingError("STORAGE_S3_ENDPOINT must be the Supabase S3 endpoint: https://<project-ref>.storage.supabase.co/storage/v1/s3 (or https://<project-ref>.supabase.co/storage/v1/s3)");
  }
  if (env.STORAGE_S3_FORCE_PATH_STYLE !== "true") throw new StagingError("STORAGE_S3_FORCE_PATH_STYLE must be true for Supabase.");
  if (env.STORAGE_S3_BUCKET_PER_LOGICAL !== "true") throw new StagingError("STORAGE_S3_BUCKET_PER_LOGICAL must be true for Supabase staging (one bucket per STORAGE_BUCKETS entry).");
  if (env.STORAGE_S3_CHECKSUMS !== "false") throw new StagingError("STORAGE_S3_CHECKSUMS must be false for Supabase (x-amz-checksum-* is not in its supported-headers list).");
  const values: Record<string, string> = {};
  for (const key of STORAGE_KEYS) values[key] = env[key];
  return {
    values,
    endpointHost: endpoint.hostname,
    secrets: [env.STORAGE_S3_SECRET_ACCESS_KEY, env.STORAGE_S3_ACCESS_KEY_ID].filter((s) => s.length >= 4),
  };
}

/** Replace every STORAGE_S3_* in process.env with exactly `values`. */
export function applyStorageEnv(values: Record<string, string>): void {
  for (const key of Object.keys(process.env)) if (key.startsWith("STORAGE_S3_")) delete process.env[key];
  Object.assign(process.env, values);
}

export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out
    .replace(/postgres(ql)?:\/\/[^@\s"']+@/g, "postgresql://***@")
    .replace(/(X-Amz-Credential|X-Amz-Signature|token)=[^&\s"']+/g, "$1=***");
}
