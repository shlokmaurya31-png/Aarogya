import { createHash } from "node:crypto";

/**
 * Flagship 6 — the ABDM side of Scan and Share, as an adapter
 * (docs/ABDM_CERTIFICATION_PLAN.md §4, §7.3–7.4, §8).
 *
 * In ABDM's flow, a patient scans the facility's QR in a PHR app, approves
 * sharing their ABHA profile, and the gateway delivers that profile to the
 * facility (the HIP); the HIP answers with a queue token ("on-share"), which
 * the gateway shows the patient. The facility only ever needs two things from
 * ABDM here, and they are this interface:
 *
 *   verifyAbha        M1 verify-only (decided §7.3): is this ABHA real and
 *                     active? Never creates one; no Aadhaar OTP flow.
 *   acknowledgeShare  the on-share answer with the token.
 *
 * The profile's shape below follows the plan; its exact field names are to be
 * verified against the current v3 specification before the sandbox adapter
 * is written (§3.1: no code against a guessed contract). Until then the MOCK
 * adapter stands in, and is the only one: `scanShareGateway()` refuses any
 * other mode.
 */

/** What the gateway delivers to the HIP when a patient shares their profile. */
export interface AbdmProfileShare {
  requestId: string;
  timestamp: string;
  /** The facility's HIP id (its HFR id once registered; the facility id in the mock). */
  hipId: string;
  /** The counter the QR named. */
  counterId: string;
  profile: {
    abhaNumber: string | null;
    abhaAddress: string;
    name: string;
    gender: "M" | "F" | "O";
    yearOfBirth: number | null;
    monthOfBirth: number | null;
    dayOfBirth: number | null;
    phoneNumber: string | null;
  };
}

export interface OnShareAck { requestId: string; hipId: string; counterId: string; abhaAddress: string; tokenNumber: string; expiresAt: string }

export interface ScanShareGateway {
  readonly mode: "MOCK";
  verifyAbha(input: { abhaAddress: string; abhaNumber: string | null }): Promise<{ verified: true; abhaNumber: string } | { verified: false; reason: "UNKNOWN_ABHA" | "INACTIVE_ABHA" }>;
  acknowledgeShare(ack: OnShareAck): Promise<void>;
}

const ABHA_ADDRESS = /^[a-z0-9][a-z0-9._]{2,31}@(sbx|abdm)$/;

/** The mock's ABHA number for an address: 14 digits starting 91, derived (synthetic, never a real ABHA). */
export function mockAbhaNumber(abhaAddress: string): string {
  const h = createHash("sha256").update(`mock-abha:${abhaAddress.toLowerCase()}`).digest();
  let digits = "91";
  for (let i = 0; digits.length < 14; i++) digits += String(h[i] % 10);
  return digits;
}

/** Acknowledgements the mock received (for the gates; never a real call). */
export const mockAcks: OnShareAck[] = [];

const mock: ScanShareGateway = {
  mode: "MOCK",
  async verifyAbha({ abhaAddress, abhaNumber }) {
    const a = abhaAddress.trim().toLowerCase();
    // The mock's "inactive" ABHA, so the refusal path can be exercised.
    if (!ABHA_ADDRESS.test(a)) return { verified: false, reason: "UNKNOWN_ABHA" };
    if (a.startsWith("inactive")) return { verified: false, reason: "INACTIVE_ABHA" };
    const number = mockAbhaNumber(a);
    if (abhaNumber && abhaNumber.replace(/\D/g, "") !== number) return { verified: false, reason: "UNKNOWN_ABHA" };
    return { verified: true, abhaNumber: number };
  },
  async acknowledgeShare(ack) {
    mockAcks.push(ack);
    if (mockAcks.length > 1000) mockAcks.splice(0, mockAcks.length - 1000);
  },
};

/** The adapter in use. Only the mock exists until the sandbox step of the plan (§5). */
export function scanShareGateway(): ScanShareGateway {
  const mode = (process.env.ABDM_SCAN_SHARE_MODE ?? "mock").toLowerCase();
  if (mode !== "mock") throw new Error(`ABDM_SCAN_SHARE_MODE=${mode}: only the mock Scan and Share adapter exists; the sandbox one waits for the verified v3 specification and credentials (ABDM plan §3.1, §5).`);
  return mock;
}
