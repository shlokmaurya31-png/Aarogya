import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Week 5c — member and policy numbers on insurance cards, encrypted at rest
 * (docs/PATIENT_INSURANCE_DESIGN.md §2): AES-256-GCM, a fresh IV per value,
 * its own key purpose (INSURANCE_CARD_KEY_<version>, 32 bytes base64, the
 * version in INSURANCE_CARD_KEY_VERSION). No key: cards can't be stored
 * (never in plain text). Format: base64(iv | tag | ciphertext).
 */
function keyFor(version: number, env: Record<string, string | undefined>): Buffer | null {
  if (!Number.isInteger(version) || version < 1) return null;
  const raw = env[`INSURANCE_CARD_KEY_${version}`];
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function currentCardKey(env: Record<string, string | undefined> = process.env): { version: number; key: Buffer } | null {
  const version = Number(env.INSURANCE_CARD_KEY_VERSION ?? "1");
  const key = keyFor(version, env);
  return key ? { version, key } : null;
}

export function encryptCardValue(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decryptCardValue(cipher: string, version: number, env: Record<string, string | undefined> = process.env): string {
  const key = keyFor(version, env);
  if (!key) throw new Error(`No key for card key version ${version}.`);
  const buf = Buffer.from(cipher, "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

/** "••••1234": the last 4 only. */
export function maskLast4(last4: string | null | undefined): string | null {
  return last4 ? `••••${last4}` : null;
}
