/**
 * Supabase staging database commands (docs/STAGING_SUPABASE.md).
 *
 *   npm run staging:migrate              prisma migrate deploy (via DIRECT_URL)
 *   STAGING_CONFIRM=yes npm run staging:seed   demo seed (refuses without the flag)
 *   npm run staging:check                connectivity, Postgres version,
 *                                        migration status, pgvector placement
 *   STAGING_CONFIRM=yes npm run staging:document
 *                                        one real PDF through src/lib/documents,
 *                                        stored in Supabase Storage; checks the
 *                                        generated-pdf bucket and the QR link
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
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { ROOT, StagingError, applyStorageEnv, loadStagingStorage, readStagingEnvFile, scrub } from "./lib/stagingEnv";
import { readQrCodes } from "./lib/pdfQr";

const PRISMA = path.join(ROOT, "node_modules", ".bin", "prisma");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

/** host:port/database, never credentials. */
function describe(url: URL): string {
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

function loadStaging() {
  const env = readStagingEnvFile();
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

/**
 * Generates one real document through the documents service against staging
 * (database + Supabase Storage), then proves: the PDF is in the generated-pdf
 * bucket with the recorded sha256, its signed URL downloads it, the QR printed
 * on it is APP_BASE_URL/verify/<token>, and that page says "Authentic
 * document" for it and "Not verified" for a made-up token. The document is
 * kept, so it can be inspected in the Supabase dashboard.
 */
async function document() {
  const env = readStagingEnvFile();
  const { urls, secrets } = loadStaging();
  const storage = loadStagingStorage(env);
  const allSecrets = [...secrets, ...storage.secrets];
  if (process.env.STAGING_CONFIRM !== "yes") {
    throw new StagingError("Refusing to write a document to staging without STAGING_CONFIRM=yes. Run: STAGING_CONFIRM=yes npm run staging:document");
  }
  const appBaseUrl = env.APP_BASE_URL;
  if (!appBaseUrl || /[<>]/.test(appBaseUrl)) throw new StagingError("APP_BASE_URL is not set in .env.staging.local (the staging app's public URL; the QR links point there).");
  try {
    new URL(appBaseUrl);
  } catch {
    throw new StagingError("APP_BASE_URL in .env.staging.local is not a valid URL.");
  }

  // Point the app modules at staging BEFORE importing them (prisma and the
  // storage adapter read the environment on first use).
  Object.assign(process.env, { DATABASE_URL: urls.DATABASE_URL.toString(), DIRECT_URL: urls.DIRECT_URL.toString(), APP_BASE_URL: appBaseUrl });
  applyStorageEnv(storage.values);
  console.log(`staging:document → db ${describe(urls.DATABASE_URL)}, storage ${storage.endpointHost}, APP_BASE_URL ${appBaseUrl}`);
  await generateAndCheckDocument(allSecrets);
}

/** Exported for a local rehearsal against Postgres + a local S3 server. */
export async function generateAndCheckDocument(secrets: string[]) {
  const { prisma } = await import("../src/lib/db");
  const { generateAndStoreDocument, verifyUrlFor } = await import("../src/lib/documents/service");
  const { getStorageAdapter } = await import("../src/lib/storage");
  const { S3StorageAdapter } = await import("../src/lib/storage/s3Adapter");
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const problems: string[] = [];
  const step = (name: string, ok: boolean, detail = "") => {
    if (!ok) problems.push(name);
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${scrub(detail, secrets)})` : ""}`);
  };

  try {
    const adapter = getStorageAdapter();
    if (!(adapter instanceof S3StorageAdapter)) throw new StagingError("The storage adapter is not S3; check the STORAGE_S3_* values.");

    const facility = await prisma.facility.findFirst({ where: { name: "Aarogya Medical Centre" } });
    if (!facility) throw new StagingError('Seeded facility "Aarogya Medical Centre" not found. Run STAGING_CONFIRM=yes npm run staging:seed first.');
    const patient = await prisma.patient.findFirst({ where: { facilityId: facility.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

    const doc = await generateAndStoreDocument(
      {
        type: "prescription",
        patient: { name: patient?.fullName ?? "Synthetic Patient", uhid: patient?.uhid ?? undefined },
        diagnosis: "Staging smoke test (synthetic data)",
        items: [{ drug: "Paracetamol 500 mg", dose: "1 tablet", frequency: "TDS", duration: "3 days" }],
        advice: "Generated by npm run staging:document.",
      },
      {
        facilityId: facility.id,
        patientId: patient?.id ?? null,
        letterhead: { facilityName: facility.name, authorName: "Staging smoke test" },
      }
    );
    console.log(`  generated ${doc.documentNumber} · GeneratedDocument ${doc.id}`);

    const { Bucket, Key } = adapter.locate(doc.storageRef);
    step("stored in the generated-pdf bucket", Bucket === "generated-pdf", `s3://${Bucket}/${Key}`);

    const loaded = await adapter.get(doc.storageRef);
    step("object sha256 matches the GeneratedDocument row", sha(loaded.bytes) === doc.sha256, `${loaded.bytes.length} bytes, ${loaded.contentType}`);

    const res = await fetch(doc.downloadUrl);
    const downloaded = new Uint8Array(await res.arrayBuffer());
    step("signed download URL returns the PDF", res.status === 200 && sha(downloaded) === doc.sha256, `HTTP ${res.status}`);

    const expected = verifyUrlFor(doc.verifyToken);
    const qrs = await readQrCodes(loaded.bytes);
    step("QR on the PDF is APP_BASE_URL/verify/<token>", qrs.includes(expected), `QR: ${qrs.join(", ") || "none decoded"}`);

    try {
      const page = await fetch(expected);
      const html = await page.text();
      step("QR link: page says Authentic document", page.status === 200 && html.includes("Authentic document") && html.includes(doc.documentNumber), `HTTP ${page.status}`);
      const bogus = await fetch(expected.replace(/\/verify\/.*$/, "/verify/not-a-real-token"));
      const bogusHtml = await bogus.text();
      step("made-up token: page says Not verified", bogusHtml.includes("Not verified"), `HTTP ${bogus.status}`);
    } catch (err) {
      step("QR link reachable", false, `${(err as Error).cause ?? (err as Error).message} — is the app at APP_BASE_URL running against this database?`);
    }
  } finally {
    await prisma.$disconnect();
  }

  if (problems.length) {
    console.error(`\nstaging:document FAILED: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nstaging:document OK");
  }
}

const commands: Record<string, () => Promise<void>> = { migrate, seed, check, document };
const name = process.argv[2] ?? "";
const command = commands[name];
// Only when run directly; importing generateAndCheckDocument runs nothing.
if (require.main === module) {
  if (!command) {
    console.error(`Usage: tsx scripts/staging.ts <${Object.keys(commands).join("|")}>`);
    process.exit(2);
  }
  command().catch((err) => {
    console.error(err instanceof StagingError ? err.message : err);
    process.exitCode = 1;
  });
}
