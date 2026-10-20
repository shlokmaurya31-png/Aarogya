/**
 * The local database a destructive or test run may use (verify:all, the
 * browser smoke tests). Refuses Supabase always, any non-local host unless
 * ALLOW_REMOTE_VERIFY=1, and a database named like the dev database
 * (DATABASE_URL / DIRECT_URL). Moved out of scripts/verify-all.ts (Week 4c) so
 * the smoke harness applies the same refusals.
 */
export function hostOf(name: string, url: string | undefined): string {
  if (!url) throw new Error(`${name} is not set (see .env.example).`);
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
}

export const DEFAULT_VERIFY_URL = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

function dbName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/**
 * The database verify:all resets and every child process uses. Refuses
 * Supabase always, any non-local host unless ALLOW_REMOTE_VERIFY=1, and a
 * verify database named like the dev database (DATABASE_URL / DIRECT_URL).
 */
export function resolveVerifyTarget(envVar = "VERIFY_DATABASE_URL"): { url: string; host: string; name: string } {
  const raw = process.env[envVar] || DEFAULT_VERIFY_URL;
  const host = hostOf(envVar, raw);
  const verify = new URL(raw);
  // Staging (Supabase) is never a valid target, whatever the override says.
  if (/(^|\.)supabase\.(co|com)$/i.test(host)) {
    throw new Error(`Refusing to run: "${host}" is the Supabase staging database. verify:all must never run against staging (docs/STAGING_SUPABASE.md).`);
  }
  if (!LOCAL_HOSTS.includes(host) && process.env.ALLOW_REMOTE_VERIFY !== "1") {
    throw new Error(
      `Refusing to run: "${host}" is not localhost. verify:all wipes the database. ` +
        "Set ALLOW_REMOTE_VERIFY=1 only if that database is disposable."
    );
  }
  const name = dbName(verify);
  if (!name) throw new Error("Refusing to run: VERIFY_DATABASE_URL names no database.");
  // The dev database is never the verify database, even on another host
  // (the names are what a mistyped override most often gets wrong).
  for (const devVar of ["DATABASE_URL", "DIRECT_URL"]) {
    const dev = process.env[devVar];
    if (!dev) continue;
    hostOf(devVar, dev);
    if (dbName(new URL(dev)) === name) {
      throw new Error(
        `Refusing to run: the verify database "${name}" has the same name as the dev database in ${devVar}. ` +
          "verify:all resets its database; point VERIFY_DATABASE_URL at a separate one (default aarogya_verify)."
      );
    }
  }
  return { url: raw, host, name };
}

