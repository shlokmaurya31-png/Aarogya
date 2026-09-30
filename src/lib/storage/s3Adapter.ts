/**
 * Phase 1.1 — S3 / S3-compatible storage adapter (S3, Cloudflare R2, MinIO).
 *
 * Activates ONLY when the STORAGE_S3_* credentials exist in the environment
 * (see .env.example). Until then getStorageAdapter never selects it, so this
 * code path is dormant, not faked. Downloads use provider-native presigned URLs.
 *
 * The AWS SDK is imported dynamically so the default local-disk path never pays
 * to load it.
 */
import type {
  LoadedObject,
  PutObjectInput,
  SignedDownload,
  StorageAdapter,
  StoredObject,
} from "./types";
import { validateUpload } from "./validation";
import { buildRef, assertSafeRef } from "./ref";
import { clampTtl } from "./token";
import { createHash } from "crypto";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  keyPrefix?: string;
  forcePathStyle?: boolean;
}

export function readS3ConfigFromEnv(): S3Config | null {
  const bucket = process.env.STORAGE_S3_BUCKET;
  const region = process.env.STORAGE_S3_REGION;
  const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
    keyPrefix: process.env.STORAGE_S3_KEY_PREFIX || undefined,
    forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === "true",
  };
}

export class S3StorageAdapter implements StorageAdapter {
  readonly name = "s3";
  readonly configured = true;
  private readonly cfg: S3Config;
  // Lazily constructed AWS S3 client; typed loosely to avoid a hard build-time
  // dependency on the SDK's exported types in calling code.
  private clientPromise: Promise<unknown> | null = null;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  private key(storageRef: string): string {
    const prefix = this.cfg.keyPrefix ? this.cfg.keyPrefix.replace(/\/+$/, "") + "/" : "";
    return prefix + storageRef;
  }

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { S3Client } = await import("@aws-sdk/client-s3");
        return new S3Client({
          region: this.cfg.region,
          endpoint: this.cfg.endpoint,
          forcePathStyle: this.cfg.forcePathStyle,
          credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
        });
      })();
    }
    return this.clientPromise;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const contentType = validateUpload(input.bucket, input.bytes, input.contentType);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const storageRef = buildRef(input.bucket, sha256, input.originalName, input.scope);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (await this.client()) as any;
    await client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(storageRef),
        Body: input.bytes,
        ContentType: contentType,
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      })
    );
    return { storageRef, sha256, size: input.bytes.length, contentType };
  }

  async get(storageRef: string): Promise<LoadedObject> {
    assertSafeRef(storageRef);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (await this.client()) as any;
    const res = await client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(storageRef) }));
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    return { bytes, contentType: res.ContentType ?? "application/octet-stream" };
  }

  async signedDownloadUrl(storageRef: string, expiresInSeconds?: number): Promise<SignedDownload> {
    assertSafeRef(storageRef);
    const ttl = clampTtl(expiresInSeconds);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (await this.client()) as any;
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(storageRef) }),
      { expiresIn: ttl }
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  async delete(storageRef: string): Promise<void> {
    assertSafeRef(storageRef);
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (await this.client()) as any;
    await client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(storageRef) }));
  }
}
