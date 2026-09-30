import { describe, it, expect, afterAll } from "vitest";
import { rm } from "fs/promises";
import path from "path";

// Storage tokens are HMAC-signed with AUTH_SECRET; set one for the suite.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-storage-000000000000000000000";

import { sniffContentType, validateUpload, safeName, safeScope, maxSizeForBucket } from "./validation";
import { buildRef, assertSafeRef } from "./ref";
import { createDownloadToken, verifyDownloadToken, clampTtl, DEFAULT_TTL_SECONDS } from "./token";
import { LocalDiskStorageAdapter } from "./localAdapter";
import { getStorageAdapter, __resetStorageAdapterForTests } from "./index";
import { StorageValidationError, StorageRefError } from "./types";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);

describe("content-type sniffing", () => {
  it("recognises the accepted formats from their bytes", () => {
    expect(sniffContentType(PDF)).toBe("application/pdf");
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(JPEG)).toBe("image/jpeg");
    expect(sniffContentType(WEBP)).toBe("image/webp");
  });
  it("returns null for unrecognised bytes", () => {
    expect(sniffContentType(Buffer.from("not a real file"))).toBeNull();
  });
});

describe("upload validation", () => {
  it("accepts a matching type and returns the sniffed type", () => {
    expect(validateUpload("reports", PDF, "application/pdf")).toBe("application/pdf");
  });
  it("rejects an empty file", () => {
    expect(() => validateUpload("reports", Buffer.alloc(0), "application/pdf")).toThrow(StorageValidationError);
  });
  it("rejects a type not allowed in the bucket (reports = pdf only)", () => {
    expect(() => validateUpload("reports", PNG, "image/png")).toThrow(StorageValidationError);
  });
  it("rejects a declared type that disagrees with the bytes (smuggling)", () => {
    expect(() => validateUpload("clinical-documents", PNG, "application/pdf")).toThrow(StorageValidationError);
  });
  it("rejects an oversize file", () => {
    const tooBig = Buffer.concat([PDF, Buffer.alloc(maxSizeForBucket("reports") + 1)]);
    expect(() => validateUpload("reports", tooBig, "application/pdf")).toThrow(StorageValidationError);
  });
});

describe("filename + scope sanitisation", () => {
  it("strips paths and unsafe characters from filenames", () => {
    expect(safeName("../../etc/pa ss?wd.pdf")).toBe("pa_ss_wd.pdf");
  });
  it("sanitises scope and returns null for empty", () => {
    expect(safeScope("fac_123")).toBe("fac_123");
    expect(safeScope("!!!")).toBeNull();
    expect(safeScope(undefined)).toBeNull();
  });
});

describe("storageRef construction + safety", () => {
  it("builds a bucket/scope/sha-name ref", () => {
    const ref = buildRef("clinical-documents", "a".repeat(64), "scan.pdf", "patient42");
    expect(ref).toBe("clinical-documents/patient42/aaaaaaaaaaaaaaaa-scan.pdf");
    expect(assertSafeRef(ref)).toBe("clinical-documents");
  });
  it("rejects traversal, absolute, backslash and unknown-bucket refs", () => {
    expect(() => assertSafeRef("clinical-documents/../secret")).toThrow(StorageRefError);
    expect(() => assertSafeRef("/etc/passwd")).toThrow(StorageRefError);
    expect(() => assertSafeRef("reports\\win")).toThrow(StorageRefError);
    expect(() => assertSafeRef("not-a-bucket/x")).toThrow(StorageRefError);
  });
});

describe("download tokens", () => {
  it("round-trips a ref through sign/verify", () => {
    const ref = "reports/fac1/abc-report.pdf";
    const { token } = createDownloadToken(ref, 60);
    expect(verifyDownloadToken(token)).toBe(ref);
  });
  it("rejects a tampered signature", () => {
    const { token } = createDownloadToken("reports/x.pdf", 60);
    expect(verifyDownloadToken(token.slice(0, -2) + "zz")).toBeNull();
  });
  it("rejects an already-expired token", () => {
    const { token } = createDownloadToken("reports/x.pdf", 60);
    const [ref, , sig] = token.split(".");
    const past = `${ref}.${Date.now() - 1000}.${sig}`;
    expect(verifyDownloadToken(past)).toBeNull();
  });
  it("clamps TTL into policy bounds", () => {
    expect(clampTtl(5)).toBeGreaterThanOrEqual(30);
    expect(clampTtl(99999)).toBeLessThanOrEqual(60 * 15);
    expect(clampTtl(undefined)).toBe(DEFAULT_TTL_SECONDS);
  });
});

describe("local-disk adapter", () => {
  const adapter = new LocalDiskStorageAdapter();
  const refs: string[] = [];

  afterAll(async () => {
    await rm(path.join(process.cwd(), ".data", "object-store"), { recursive: true, force: true });
  });

  it("puts and gets an object round-trip with a stable sha", async () => {
    const stored = await adapter.put({ bucket: "reports", bytes: PDF, contentType: "application/pdf", originalName: "r.pdf" });
    refs.push(stored.storageRef);
    expect(stored.size).toBe(PDF.length);
    expect(stored.sha256).toHaveLength(64);
    const loaded = await adapter.get(stored.storageRef);
    expect(Buffer.compare(loaded.bytes, PDF)).toBe(0);
  });

  it("issues a signed URL whose token resolves back to the same ref", async () => {
    const stored = await adapter.put({ bucket: "reports", bytes: PDF, contentType: "application/pdf", originalName: "s.pdf" });
    const { url } = await adapter.signedDownloadUrl(stored.storageRef);
    const token = new URL(url, "http://x").searchParams.get("token")!;
    expect(verifyDownloadToken(token)).toBe(stored.storageRef);
  });

  it("deletes an object", async () => {
    const stored = await adapter.put({ bucket: "reports", bytes: PDF, contentType: "application/pdf", originalName: "d.pdf" });
    await adapter.delete(stored.storageRef);
    await expect(adapter.get(stored.storageRef)).rejects.toBeTruthy();
  });
});

describe("adapter selection", () => {
  it("defaults to local-disk when no S3 credentials are set", () => {
    const saved = { ...process.env };
    delete process.env.STORAGE_S3_BUCKET;
    delete process.env.STORAGE_S3_REGION;
    delete process.env.STORAGE_S3_ACCESS_KEY_ID;
    delete process.env.STORAGE_S3_SECRET_ACCESS_KEY;
    __resetStorageAdapterForTests();
    expect(getStorageAdapter().name).toBe("local-disk");
    Object.assign(process.env, saved);
    __resetStorageAdapterForTests();
  });
});
