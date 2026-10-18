/**
 * EMAIL_PROVIDER=outbox writes messages (including sign-in and account-merge
 * codes) to a local file instead of sending them. That is for development
 * and the integrity gates only: it must never run where real people's mail
 * is at stake. Refused when:
 *   - NODE_ENV is "production" (a deployed build), or
 *   - the real-data switch is on (AI_REAL_DATA_ENABLED=true: real-data
 *     staging), or
 *   - Vercel says this is a production or preview deployment.
 * The server refuses to boot (src/instrumentation.ts), and sendEmail refuses
 * too, in case anything runs outside the server.
 */
export class UnsafeEmailProviderError extends Error {
  constructor(reason: string) {
    super(`EMAIL_PROVIDER=outbox is not allowed here (${reason}): it writes codes to a local file instead of sending them.`);
    this.name = "UnsafeEmailProviderError";
  }
}

export function assertEmailProviderAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.EMAIL_PROVIDER !== "outbox") return;
  if (env.NODE_ENV === "production") throw new UnsafeEmailProviderError("NODE_ENV=production");
  if (env.AI_REAL_DATA_ENABLED === "true") throw new UnsafeEmailProviderError("the real-data switch is on");
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") throw new UnsafeEmailProviderError(`VERCEL_ENV=${env.VERCEL_ENV}`);
}
