/**
 * The hard guard every gate and verify script runs before anything else: both
 * DATABASE_URL and DIRECT_URL must name the database `aarogya_verify` on a
 * local host. Prisma reads DATABASE_URL for queries and DIRECT_URL for
 * migrations, and .env points both at the dev database, so overriding only one
 * of them is the trap this closes (a gate run by hand with DATABASE_URL alone
 * set would still migrate or reset the dev data through DIRECT_URL).
 *
 * No override: there is no ALLOW_REMOTE flag here. A gate writes, and the only
 * database a gate may write is the local verify database.
 *
 * Pure (no I/O) so it can be unit-tested; scripts/lib/gateBootstrap.ts applies
 * it to the process's effective environment.
 */
export const GATE_DATABASE = "aarogya_verify";
export const GATE_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const GATE_URL_VARS = ["DATABASE_URL", "DIRECT_URL"] as const;

/** Why the environment is not a valid gate target, or null when it is. */
export function gateDatabaseProblem(env: Record<string, string | undefined>): string | null {
  for (const name of GATE_URL_VARS) {
    const raw = env[name];
    if (!raw) return `${name} is not set. Gates run only against ${GATE_DATABASE} on localhost (set both DATABASE_URL and DIRECT_URL).`;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `${name} is not a valid URL.`;
    }
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return `${name} is not a PostgreSQL URL.`;
    if (!GATE_HOSTS.includes(url.hostname)) {
      return `${name} points at host "${url.hostname}", not localhost. Gates never run against a remote database (staging included).`;
    }
    const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (db !== GATE_DATABASE) {
      return `${name} names the database "${db || "(none)"}", not ${GATE_DATABASE}. Gates write and reset; they never touch the dev database.`;
    }
  }
  return null;
}

/** Throws unless both URLs point at aarogya_verify on localhost. */
export function assertGateDatabase(env: Record<string, string | undefined>): void {
  const problem = gateDatabaseProblem(env);
  if (problem) throw new Error(`Refusing to start: ${problem}`);
}
