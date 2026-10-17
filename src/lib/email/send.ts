import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Transactional email. One provider, Resend, over its REST API (no SDK
 * dependency), enabled by RESEND_API_KEY + EMAIL_FROM.
 *
 * Unconfigured behaviour is explicit, never faked:
 *   - development: the message is printed to the server console (a dev
 *     outbox), so flows like password reset can be exercised locally;
 *   - production: nothing is sent and an error is logged. Callers must not
 *     tell the user an email was delivered based on this alone.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type EmailResult = { delivered: true } | { delivered: false; reason: "unconfigured" | "failed" };

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/** EMAIL_PROVIDER=outbox (dev and gates): messages are appended here instead of sent. */
export const EMAIL_OUTBOX_FILE = path.join(process.cwd(), ".data", "outbox", "email.jsonl");

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  if (process.env.EMAIL_PROVIDER === "outbox") {
    try {
      await mkdir(path.dirname(EMAIL_OUTBOX_FILE), { recursive: true });
      await appendFile(EMAIL_OUTBOX_FILE, JSON.stringify({ ...message, at: new Date().toISOString() }) + "\n");
      return { delivered: true };
    } catch (err) {
      console.error("Email outbox write failed.", err);
      return { delivered: false, reason: "failed" };
    }
  }
  if (!emailConfigured()) {
    if (process.env.NODE_ENV !== "production") {
      console.info(
        `\n── Dev outbox (RESEND_API_KEY/EMAIL_FROM unset) ──\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n──────────────────────────────────────────────\n`
      );
    } else {
      console.error(`Email not sent (no provider configured): "${message.subject}".`);
    }
    return { delivered: false, reason: "unconfigured" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Resend rejected email "${message.subject}": HTTP ${res.status} ${await res.text()}`);
      return { delivered: false, reason: "failed" };
    }
    return { delivered: true };
  } catch (err) {
    console.error(`Resend request failed for "${message.subject}".`, err);
    return { delivered: false, reason: "failed" };
  }
}
