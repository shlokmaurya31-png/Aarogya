/**
 * Supabase staging database commands (docs/STAGING_SUPABASE.md).
 *
 *   npm run staging:migrate              prisma migrate deploy (via DIRECT_URL)
 *   STAGING_CONFIRM=yes npm run staging:seed   demo seed (refuses without the flag)
 *   npm run staging:check                connectivity, Postgres version,
 *                                        migration status, pgvector placement
 *
 * Credentials come ONLY from .env.staging.local (gitignored). Values in the
 * shell or in .env are deliberately not used for the database URLs, so a
 * local URL can never be mistaken for staging, or the other way round.
 * Nothing here prints a password or a full URL: output shows host, port and
 * database only, and child-process output is scrubbed as well.
 *
 * verify:all must never run against staging; scripts/verify-all.ts refuses
 * Supabase hosts outright.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.staging.local");
const PRISMA = path.join(ROOT, "node_modules", ".bin", "prisma");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

class StagingError extends Error {}

/** Minimal .env parser: KEY=value, optional quotes, # comments. */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** host:port/database, never credentials. */
function describe(url: URL): string {
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

function loadStaging() {
  if (!existsSync(ENV_FILE)) {
    throw new StagingError("Missing .env.staging.local. Create it with: cp .env.staging.example .env.staging.local, then fill in the values (docs/STAGING_SUPABASE.md).");
  }
  const env = readEnvFile(ENV_FILE);
  const urls: Record<"DATABASE_URL" | "DIRECT_URL", URL> = {} as never;
  for (const key of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const value = env[key];
    if (!value) throw new StagingError(`${key} is not set in .env.staging.local.`);
    if (/[<>]/.test(value)) throw new StagingError(`${key} in .env.staging.local still contains a <placeholder>.`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new StagingError(`${key} in .env.staging.local is not a valid URL.`);
    }
    if (!/^postgres(ql)?:$/.test(url.protocol)) throw new StagingError(`${key} must be a postgresql:// URL.`);
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      throw new StagingError(`${key} points at ${url.hostname}; staging commands only target the remote staging database.`);
    }
    urls[key] = url;
  }
  if (urls.DATABASE_URL.port !== "6543" || urls.DATABASE_URL.searchParams.get("pgbouncer") !== "true") {
    throw new StagingError("DATABASE_URL must be the Supabase transaction pooler: port 6543 with ?pgbouncer=true.");
  }
  if (urls.DIRECT_URL.port === "6543") {
    throw new StagingError("DIRECT_URL must not be the transaction pooler (6543); use the session pooler (5432) for migrations.");
  }
  const secrets = Object.values(urls)
    .flatMap((u) => [u.password, decodeURIComponent(u.password), u.toString()])
    .filter((s) => s.length >= 4);
  return { env, urls, secrets };
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out.replace(/postgres(ql)?:\/\/[^@\s"']+@/g, "postgresql://***@");
}

function run(cmd: string, args: string[], childEnv: NodeJS.ProcessEnv, secrets: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => process.stdout.write(scrub(String(d), secrets)));
    child.stderr.on("data", (d) => process.stderr.write(scrub(String(d), secrets)));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function childEnv(urls: { DATABASE_URL: URL; DIRECT_URL: URL }): NodeJS.ProcessEnv {
  // Only the staging URLs; SHADOW_DATABASE_URL is irrelevant to deploy/status
  // and is dropped so no local value travels along.
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: urls.DATABASE_URL.toString(), DIRECT_URL: urls.DIRECT_URL.toString() };
  delete env.SHADOW_DATABASE_URL;
  return env;
}

async function migrate() {
  const { urls, secrets } = loadStaging();
  console.log(`staging:migrate → ${describe(urls.DIRECT_URL)} (direct/session connection)`);
  const code = await run(PRISMA, ["migrate", "deploy"], childEnv(urls), secrets);
  if (code !== 0) throw new StagingError(`prisma migrate deploy exited with ${code}.`);
}

async function seed() {
  const { urls, secrets } = loadStaging();
  if (process.env.STAGING_CONFIRM !== "yes") {
    throw new StagingError(
      "Refusing to seed staging without STAGING_CONFIRM=yes. The seed creates demo accounts with well-known passwords. " +
        "Run: STAGING_CONFIRM=yes npm run staging:seed"
    );
  }
  console.log(`staging:seed → ${describe(urls.DATABASE_URL)} (transaction pooler)`);
  const code = await run(TSX, ["prisma/seed.ts"], childEnv(urls), secrets);
  if (code !== 0) throw new StagingError(`Seed exited with ${code}.`);
}

async function check() {
  const { urls, secrets } = loadStaging();
  const problems: string[] = [];

  const client = new PrismaClient({ datasources: { db: { url: urls.DATABASE_URL.toString() } } });
  try {
    console.log(`App connection (transaction pooler): ${describe(urls.DATABASE_URL)}`);
    const [{ version }] = await client.$queryRaw<{ version: string }[]>`SELECT version()`;
    console.log(`  connected · ${version.split(",")[0]}`);

    const ext = await client.$queryRaw<{ extversion: string; schema: string }[]>`
      SELECT e.extversion, n.nspname AS schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'vector'`;
    if (ext.length === 0) {
      problems.push("pgvector: the vector extension is NOT installed. Run npm run staging:migrate (migration 20261013205801_enable_pgvector creates it). Do not enable it from the Supabase dashboard.");
      console.log("  pgvector: MISSING");
    } else if (ext[0].schema !== "public") {
      problems.push(
        `pgvector: vector ${ext[0].extversion} is installed in schema "${ext[0].schema}", not "public". It was probably enabled from the Supabase dashboard. ` +
          "schema.prisma declares it in public and migrations own all extensions: drop it from that schema and run npm run staging:migrate."
      );
      console.log(`  pgvector: ${ext[0].extversion} in "${ext[0].schema}" (WRONG SCHEMA)`);
    } else {
      console.log(`  pgvector: ${ext[0].extversion} in "public" ✓`);
    }
  } catch (err) {
    problems.push(`Could not query staging through DATABASE_URL: ${scrub(err instanceof Error ? err.message : String(err), secrets)}`);
  } finally {
    await client.$disconnect();
  }

  console.log(`\nMigration status (direct/session connection): ${describe(urls.DIRECT_URL)}`);
  const code = await run(PRISMA, ["migrate", "status"], childEnv(urls), secrets);
  if (code !== 0) problems.push("prisma migrate status reported pending/failed migrations or could not connect (see above).");

  if (problems.length) {
    console.error("\nstaging:check FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log("\nstaging:check OK");
  }
}

const commands: Record<string, () => Promise<void>> = { migrate, seed, check };
const name = process.argv[2] ?? "";
const command = commands[name];
if (!command) {
  console.error(`Usage: tsx scripts/staging.ts <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
command().catch((err) => {
  console.error(err instanceof StagingError ? err.message : err);
  process.exitCode = 1;
});
