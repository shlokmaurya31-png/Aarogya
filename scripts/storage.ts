/**
 * Object storage commands (src/lib/storage, docs/STAGING_SUPABASE.md §4).
 *
 *   npm run storage:init                  create any missing bucket (idempotent)
 *   npm run storage:check                 put → get → sha256 → signed URL → delete
 *   npm run storage:init  -- --staging    same, against Supabase Storage
 *   npm run storage:check -- --staging
 *
 * Without --staging the target is whatever the app itself would use: the
 * adapter getStorageAdapter() selects from .env.local / .env (local disk unless
 * STORAGE_S3_* is set). With --staging the STORAGE_S3_* values come ONLY from
 * .env.staging.local, and are validated as a Supabase S3 endpoint.
 *
 * Buckets are created private: CreateBucket is sent with no ACL (Supabase
 * doesn't support ACLs), and storage:check proves privacy by requesting each
 * test object without a signature and requiring that to fail.
 *
 * storage:check only ever deletes the objects it wrote. Nothing printed
 * contains an access key, a secret or a signed URL.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getStorageAdapter, STORAGE_BUCKETS } from "../src/lib/storage";
import { LocalDiskStorageAdapter } from "../src/lib/storage/localAdapter";
import { S3StorageAdapter, readS3ConfigFromEnv } from "../src/lib/storage/s3Adapter";
import { ROOT, StagingError, applyStorageEnv, loadStagingStorage, scrub } from "./lib/stagingEnv";

const staging = process.argv.includes("--staging");
let secrets: string[] = [];

function selectTarget() {
  if (staging) {
    const s = loadStagingStorage();
    applyStorageEnv(s.values);
    secrets = s.secrets;
  } else {
    // Same precedence as Next.js: .env.local wins over .env (loadEnvFile never overrides).
    for (const f of [".env.local", ".env"]) {
      const file = path.join(ROOT, f);
      if (existsSync(file)) process.loadEnvFile(file);
    }
    const s3 = readS3ConfigFromEnv();
    if (s3) secrets = [s3.secretAccessKey, s3.accessKeyId].filter((v) => v.length >= 4);
  }
  const adapter = getStorageAdapter();
  const where =
    adapter instanceof S3StorageAdapter
      ? `s3 → ${new URL(process.env.STORAGE_S3_ENDPOINT || `https://s3.${process.env.STORAGE_S3_REGION}.amazonaws.com`).host} (${process.env.STORAGE_S3_REGION})`
      : "local disk → .data/object-store";
  console.log(`storage target: ${staging ? "STAGING " : ""}${where}`);
  return adapter;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function s3Client(): Promise<any> {
  const cfg = readS3ConfigFromEnv()!;
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...(cfg.checksums === false ? { requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" } : {}),
  });
}

async function init() {
  const adapter = selectTarget();
  if (adapter instanceof LocalDiskStorageAdapter) {
    for (const bucket of STORAGE_BUCKETS) {
      const dir = path.join(ROOT, ".data", "object-store", bucket);
      const existed = existsSync(dir);
      await mkdir(dir, { recursive: true });
      console.log(`  ${bucket.padEnd(20)} ${existed ? "exists" : "created"}`);
    }
    return;
  }
  if (!(adapter instanceof S3StorageAdapter)) throw new StagingError(`Unsupported adapter: ${adapter.name}`);
  const { HeadBucketCommand, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  if (!readS3ConfigFromEnv()!.bucketPerLogical) {
    console.log("  single-bucket layout: logical buckets are key prefixes of STORAGE_S3_BUCKET");
  }
  for (const bucket of adapter.physicalBuckets()) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      console.log(`  ${bucket.padEnd(20)} exists`);
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404 && (err as Error).name !== "NotFound" && (err as Error).name !== "NoSuchBucket") throw err;
      // No ACL: the bucket is private (Supabase rejects ACL headers anyway).
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`  ${bucket.padEnd(20)} created (private)`);
    }
  }
}

/** A small, valid, unique PDF. */
async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 120]);
  page.drawText(`Aarogya storage:check ${new Date().toISOString()} ${randomBytes(4).toString("hex")}`, {
    x: 12,
    y: 60,
    size: 8,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return Buffer.from(await doc.save());
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The object's plain, unsigned URL(s); a private bucket must refuse them. */
function unsignedUrls(adapter: S3StorageAdapter, storageRef: string): string[] {
  const cfg = readS3ConfigFromEnv()!;
  const { Bucket, Key } = adapter.locate(storageRef);
  const key = Key.split("/").map(encodeURIComponent).join("/");
  const urls = [
    cfg.endpoint
      ? `${cfg.endpoint.replace(/\/+$/, "")}/${Bucket}/${key}`
      : `https://${Bucket}.s3.${cfg.region}.amazonaws.com/${key}`,
  ];
  // Supabase also serves public buckets at /storage/v1/object/public/<bucket>/<key>.
  if (cfg.endpoint && /\.supabase\.co\//.test(cfg.endpoint)) {
    urls.push(`${cfg.endpoint.replace(/\/s3\/?$/, "")}/object/public/${Bucket}/${key}`);
  }
  return urls;
}

async function check() {
  const adapter = selectTarget();
  const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  let failures = 0;
  const step = (bucket: string, name: string, ok: boolean, detail = "") => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${bucket.padEnd(20)} ${name}${detail ? ` (${scrub(detail, secrets)})` : ""}`);
  };

  for (const bucket of STORAGE_BUCKETS) {
    const pdf = await samplePdf();
    let ref: string | null = null;
    try {
      const stored = await adapter.put({ bucket, bytes: pdf, contentType: "application/pdf", originalName: "storage-check.pdf", scope: "storage-check" });
      ref = stored.storageRef;
      const where = adapter instanceof S3StorageAdapter ? ` → s3://${adapter.locate(ref).Bucket}/${adapter.locate(ref).Key}` : "";
      step(bucket, "put", stored.sha256 === sha(pdf), `${pdf.length} bytes${where}`);

      const loaded = await adapter.get(ref);
      step(bucket, "get + sha256", sha(loaded.bytes) === sha(pdf));

      const signed = await adapter.signedDownloadUrl(ref, 60);
      const signedUrl = signed.url.startsWith("/") ? baseUrl + signed.url : signed.url;
      try {
        const res = await fetch(signedUrl);
        const body = new Uint8Array(await res.arrayBuffer());
        step(bucket, "signed URL fetch + sha256", res.status === 200 && sha(body) === sha(pdf), `HTTP ${res.status}`);
      } catch (err) {
        const hint = signed.url.startsWith("/") ? ` — local signed URLs are served by the app; start it with npm run dev (APP_BASE_URL=${baseUrl})` : "";
        step(bucket, "signed URL fetch + sha256", false, `${(err as Error).cause ?? (err as Error).message}${hint}`);
      }

      if (adapter instanceof S3StorageAdapter) {
        for (const url of unsignedUrls(adapter, ref)) {
          const res = await fetch(url);
          await res.arrayBuffer();
          step(bucket, `private (unsigned ${new URL(url).pathname.includes("/object/public/") ? "public URL" : "S3 GET"} refused)`, res.status !== 200, `HTTP ${res.status}`);
        }
      }

      await adapter.delete(ref);
      const gone = await adapter.get(ref).then(
        () => false,
        () => true
      );
      step(bucket, "delete", gone);
      if (gone) ref = null;
    } catch (err) {
      step(bucket, "unexpected error", false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      if (ref) await adapter.delete(ref).catch(() => undefined);
    }
  }

  if (failures) {
    console.error(`\nstorage:check FAILED (${failures} step${failures === 1 ? "" : "s"})`);
    process.exitCode = 1;
  } else {
    console.log("\nstorage:check OK");
  }
}

const commands: Record<string, () => Promise<void>> = { init, check };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error(`Usage: tsx scripts/storage.ts <${Object.keys(commands).join("|")}> [--staging]`);
  process.exit(2);
}
command().catch((err) => {
  console.error(scrub(err instanceof StagingError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err), secrets));
  process.exitCode = 1;
});
