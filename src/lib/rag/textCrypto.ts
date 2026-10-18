import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Week 4b — application-level encryption of retained AI question and answer
 * text (docs/RAG_DESIGN.md §4.3): AES-256-GCM, a fresh 96-bit IV per value,
 * the key from the environment (AI_TEXT_KEY_<version>: 32 bytes, base64; in
 * production from the KMS that populates the environment) and the current
 * version in AI_TEXT_KEY_VERSION, so keys rotate: old rows decrypt with the
 * version they name. No key configured: nothing is retained (metadata only).
 * Ciphertext format: base64(iv | tag | ciphertext).
 */
export function currentTextKey(env: Record<string, string | undefined> = process.env): { version: number; key: Buffer } | null {
  const version = Number(env.AI_TEXT_KEY_VERSION ?? "1");
  const key = keyFor(version, env);
  return key ? { version, key } : null;
}

function keyFor(version: number, env: Record<string, string | undefined> = process.env): Buffer | null {
  if (!Number.isInteger(version) || version < 1) return null;
  const raw = env[`AI_TEXT_KEY_${version}`];
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function encryptText(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decryptText(cipher: string, version: number, env: Record<string, string | undefined> = process.env): string {
  const key = keyFor(version, env);
  if (!key) throw new Error(`No key for text key version ${version}.`);
  const buf = Buffer.from(cipher, "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
