/**
 * SMS delivery boundary (ADR 0003). No real provider is wired yet, so:
 *
 *   SMS_PROVIDER unset, development  printed to the server console (a dev
 *                                    outbox); counts as delivered, since the
 *                                    developer can read it there.
 *   SMS_PROVIDER unset, production   NOT sent; returns { delivered: false }.
 *                                    Callers must fall back (e.g. one-time
 *                                    codes go to front-desk review instead).
 *   SMS_PROVIDER=outbox              appended to .data/outbox/sms.jsonl for
 *                                    automated tests (gates). Never set this
 *                                    in staging or production.
 *
 * A real provider (e.g. MSG91, an Indian DLT-registered sender) slots in here
 * behind the same function.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type SmsResult = { delivered: true } | { delivered: false; reason: "unconfigured" | "failed" };

export const SMS_OUTBOX_FILE = path.join(process.cwd(), ".data", "outbox", "sms.jsonl");

export async function sendSms(to: string, text: string): Promise<SmsResult> {
  const provider = process.env.SMS_PROVIDER;
  if (provider === "outbox") {
    try {
      await mkdir(path.dirname(SMS_OUTBOX_FILE), { recursive: true });
      await appendFile(SMS_OUTBOX_FILE, JSON.stringify({ to, text, at: new Date().toISOString() }) + "\n");
      return { delivered: true };
    } catch (err) {
      console.error("SMS outbox write failed.", err);
      return { delivered: false, reason: "failed" };
    }
  }
  if (provider) {
    console.error(`SMS_PROVIDER="${provider}" is not a supported provider; SMS not sent.`);
    return { delivered: false, reason: "unconfigured" };
  }
  if (process.env.NODE_ENV !== "production") {
    console.info(`\n── Dev SMS outbox (SMS_PROVIDER unset) ──\nTo: ${to}\n${text}\n─────────────────────────────────────────\n`);
    return { delivered: true };
  }
  console.error("SMS not sent: no SMS provider is configured.");
  return { delivered: false, reason: "unconfigured" };
}

/** "+91 98765 43210" → "••••••3210": enough for a person to recognise their own number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return `••••••${digits.slice(-4)}`;
}
