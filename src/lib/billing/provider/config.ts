import type { BillingProviderKind } from "@prisma/client";

/**
 * Phase D4 — server-only payment-provider configuration.
 *
 * Credentials come EXCLUSIVELY from the environment and are never persisted in
 * Prisma, never returned from an API route, and never sent to the browser. This
 * module is server-only; importing it from a client component is a mistake. A
 * missing/invalid configuration produces a deterministic ProviderConfigError
 * rather than a vague failure, and error messages never contain secret values.
 */

export class ProviderConfigError extends Error {
  readonly status = 503 as const;
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl: string;
  /** Reject webhooks whose timestamp is older than this (replay window), if present. */
  webhookToleranceSeconds: number;
}

/** Read + validate Razorpay configuration. Throws (never logs secrets) if incomplete. */
export function getRazorpayConfig(): RazorpayConfig {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const missing = [
    !keyId && "RAZORPAY_KEY_ID",
    !keySecret && "RAZORPAY_KEY_SECRET",
    !webhookSecret && "RAZORPAY_WEBHOOK_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    throw new ProviderConfigError(`Razorpay is not configured: missing ${missing.join(", ")}.`);
  }
  return {
    keyId: keyId!,
    keySecret: keySecret!,
    webhookSecret: webhookSecret!,
    baseUrl: process.env.RAZORPAY_BASE_URL ?? "https://api.razorpay.com/v1",
    webhookToleranceSeconds: Number(process.env.RAZORPAY_WEBHOOK_TOLERANCE_SECONDS ?? 300),
  };
}

/**
 * Whether a provider kind is usable right now (config present). Never throws —
 * used for honest status reporting and to decide whether the real path is
 * available without leaking why.
 */
export function isProviderConfigured(kind: BillingProviderKind): boolean {
  switch (kind) {
    case "NONE": return true;   // out-of-band / manual recording
    case "FAKE": return true;   // deterministic test double
    case "RAZORPAY":
      try { getRazorpayConfig(); return true; } catch { return false; }
    default: return false;
  }
}
