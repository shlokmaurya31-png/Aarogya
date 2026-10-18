/**
 * Runs once when a server instance starts, before it serves requests.
 * Refuses to boot with configuration that would be unsafe for real people
 * (see src/lib/email/guard.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEmailProviderAllowed } = await import("./lib/email/guard");
    assertEmailProviderAllowed();
  }
}
