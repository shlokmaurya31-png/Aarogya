# Staging: Supabase (Mumbai, ap-south-1)

Staging runs on a Supabase project in **ap-south-1 (Mumbai)**: Postgres for
the database and Supabase Storage (S3 protocol) for files, so patient-shaped
data stays in India. ADR [0002](adr/0002-supabase-mumbai-staging.md) records
why; ADR [0003](adr/0003-adapters-for-external-services.md) covers how
storage is switched on.

Credentials live **only** in `.env.staging.local`, which is gitignored.
Never commit that file, and never paste its values into chat, issues, PRs or
logs. The staging scripts read nothing else for the database URLs, and they
never print a password or a full URL.

> [!CAUTION]
> **`npm run verify:all` must never run against staging.** It resets the
> database, which drops everything, before every run. `scripts/verify-all.ts`
> refuses any `*.supabase.co` / `*.supabase.com` host, even with
> `ALLOW_REMOTE_VERIFY=1`. Do not work around it.

> [!WARNING]
> **Never enable `vector`, or any other extension `schema.prisma` declares,
> from the Supabase dashboard (Database → Extensions). Migrations own all
> extensions.** The dashboard installs extensions into the `extensions`
> schema. Our migration `20261013205801_enable_pgvector` creates `vector` in
> `public`, which is where `schema.prisma` declares it. A dashboard-enabled
> copy in the wrong schema breaks drift checks, and makes the migration a
> silent no-op. `npm run staging:check` fails if `vector` is missing, or
> installed anywhere other than `public`.

## 1. Create the project (once)

1. In [supabase.com/dashboard](https://supabase.com/dashboard), choose **New
   project**.
2. **Region:** South Asia (Mumbai), `ap-south-1`. The region cannot be
   changed later.
3. **Database password:** generate a strong one and store it in your password
   manager. You need it for both URLs below.
4. **Don't enable any extensions.** The migrations do that (see the warning
   above).

## 2. Find the two connection strings

Open the project and click **Connect** in the top bar. The **Connection
String** tab lists three options. We use two of them:

| Variable | Dashboard entry | Host and port | Used by |
|---|---|---|---|
| `DATABASE_URL` | **Transaction pooler** | `aws-0-ap-south-1.pooler.supabase.com:6543` | The app (Vercel serverless) and the seed |
| `DIRECT_URL` | **Session pooler** | `aws-0-ap-south-1.pooler.supabase.com:5432` | Prisma Migrate (`staging:migrate`, `staging:check`) |

Notes:

- **Add `?pgbouncer=true` to `DATABASE_URL`.** It makes Prisma skip prepared
  statements, which transaction pooling doesn't support. `staging:*` refuses a
  `DATABASE_URL` without it, or not on port 6543.
- **Use the Session pooler for `DIRECT_URL`, not "Direct connection".** The
  direct host, `db.<project-ref>.supabase.co`, is IPv6-only unless the paid
  IPv4 add-on is enabled. The session pooler works over IPv4 and supports
  everything Migrate needs.
- The user name is `postgres.<project-ref>` on both pooler URLs.
- Replace `[YOUR-PASSWORD]` with the database password, URL-encoded if it
  contains `@`, `:`, `/`, `?` or `#`.
- The pooler host prefix may be `aws-0-` or `aws-1-`. Copy whatever the
  dashboard shows.
- Forgot the password? Go to **Project Settings → Database → Reset database
  password**. Resetting it breaks the old URLs everywhere they are used.

Then:

```bash
cp .env.staging.example .env.staging.local   # gitignored
# edit .env.staging.local: paste both URLs, password included
```

## 3. Run the staging scripts

```bash
npm run staging:migrate                      # apply all migrations (prisma migrate deploy)
STAGING_CONFIRM=yes npm run staging:seed     # demo data; refuses without STAGING_CONFIRM=yes
npm run staging:check                        # connectivity, version, migrations, pgvector
```

| Script | What it does | Safety |
|---|---|---|
| `staging:migrate` | Runs `prisma migrate deploy` through `DIRECT_URL`. It applies pending migrations only, never resets, and never generates new migrations. | Refuses localhost, placeholders, or a `DATABASE_URL` that isn't the transaction pooler. |
| `staging:seed` | Runs `prisma/seed.ts` through `DATABASE_URL`. The seed is idempotent, so a re-run creates no duplicates. | Refuses unless `STAGING_CONFIRM=yes` is set **for that one command**. It creates demo accounts with well-known passwords (`Scholar@123`, `Hospital@123`), so staging must never hold real patient data. |
| `staging:check` | Connects through the pooler, prints the Postgres version, checks that `vector` is installed in `public`, then runs `prisma migrate status` through `DIRECT_URL`. | Read-only. Exits 1 if anything is wrong. |

Output shows only `host:port/database`. Passwords are scrubbed from all
output, including Prisma's.

## 4. Storage: Supabase Storage over S3

The app's existing S3 adapter (`src/lib/storage/s3Adapter.ts`) talks to
Supabase Storage through its S3-compatible endpoint. No Supabase SDK is
involved.

### Settings

From Supabase's [S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)
and [S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility) docs:

| Setting | Value |
|---|---|
| Endpoint | `https://<project-ref>.storage.supabase.co/storage/v1/s3`. Supabase recommends this direct storage host; `https://<project-ref>.supabase.co/storage/v1/s3` also works. |
| Region | The project region: `ap-south-1` |
| Addressing | Path-style (`STORAGE_S3_FORCE_PATH_STYLE=true`) |
| Credentials | An S3 access key pair from **Project Settings → Storage → S3 Connection**. Turn the S3 connection on there first. The keys bypass Storage RLS, so they are server-side only. |
| Signing | AWS Signature V4 (the SDK default); presigned GET URLs are supported |

**What Supabase doesn't support, and what the adapter sends:**

| Unsupported by Supabase | Adapter |
|---|---|
| Object ACLs (`x-amz-acl`, `x-amz-grant-*`) | Never sent, including on `CreateBucket`. |
| Server-side encryption (`x-amz-server-side-encryption*`) | Never sent. |
| `Content-MD5` | Never sent. |
| `x-amz-checksum-*` (not in the supported list for `PutObject`) | Sent by default: `ChecksumSHA256`, plus the SDK's default CRC32. **`STORAGE_S3_CHECKSUMS=false` turns both off**, and staging requires that setting. Integrity is still checked: `storage:check` and `staging:document` compare sha256 on read-back. |

### Buckets

Every logical bucket in `STORAGE_BUCKETS` (`src/lib/storage/types.ts`) is
its own **private** Supabase bucket of the same name
(`STORAGE_S3_BUCKET_PER_LOGICAL=true`):

`clinical-documents`, `verification`, `reports`, `patient-uploads`, `generated-pdf`

An object with storageRef `generated-pdf/<facility>/<sha16>-<name>.pdf` is
stored in bucket `generated-pdf` under key `<facility>/<sha16>-<name>.pdf`.

> [!WARNING]
> **Never make a bucket public, and don't create buckets by hand.**
> `storage:init` creates missing buckets without an ACL, so they are private.
> `storage:check` proves privacy for every bucket: it requests a test object
> without a signature, both through the S3 endpoint and through
> `/storage/v1/object/public/...`, and fails if either returns it.

### Fill in `.env.staging.local`

Fill in the `STORAGE_S3_*` and `APP_BASE_URL` lines (placeholders are in
`.env.staging.example`). The three fixed values must stay as they are:
`STORAGE_S3_FORCE_PATH_STYLE=true`, `STORAGE_S3_BUCKET_PER_LOGICAL=true` and
`STORAGE_S3_CHECKSUMS=false`. The scripts refuse anything else, and they also
refuse an endpoint that isn't `https://*.supabase.co/storage/v1/s3`.

### Run

```bash
npm run storage:init  -- --staging               # create any missing bucket (idempotent)
npm run storage:check -- --staging               # per bucket: put, get + sha256, signed URL, privacy, delete
STAGING_CONFIRM=yes npm run staging:document     # one real PDF through src/lib/documents
```

| Script | What it does | Safety |
|---|---|---|
| `storage:init` | `HeadBucket` for each bucket; `CreateBucket` (no ACL) for any that is missing. Prints `exists` or `created`. Without `--staging` it runs against the app's own storage: local disk unless `STORAGE_S3_*` is set. | Creates only; never deletes or changes a bucket. |
| `storage:check` | For each bucket: puts a small PDF, gets it back and compares sha256, fetches it through a signed URL, checks unsigned access is refused (S3 only), then deletes it and confirms it's gone. | Deletes only its own test objects (`<bucket>/storage-check/...`). Locally, signed URLs are served by the app, so `npm run dev` must be running. |
| `staging:document` | Generates a prescription for the seeded facility through `generateAndStoreDocument`. It checks that the PDF is in the `generated-pdf` bucket, its sha256 matches the `GeneratedDocument` row, and the signed URL downloads it. It also decodes the QR code from the PDF, checks it is `APP_BASE_URL/verify/<token>`, and opens it: the page must say "Authentic document", and a made-up token must say "Not verified". | Needs `STAGING_CONFIRM=yes` (it writes a document row and audit event) and a seeded database. The staging app at `APP_BASE_URL` must use the staging database. The document is kept so you can inspect it in the dashboard. |

Nothing printed contains an access key, a secret, a signed URL or a
database password.

## 5. Point Vercel at staging

When a deployment should use staging, set these in the Vercel project's
environment variables, for the Preview environment or whichever one is
staging:

- `DATABASE_URL`: the transaction pooler URL, with `?pgbouncer=true`.
- `DIRECT_URL`: the session pooler URL. The app doesn't use it at runtime,
  but it keeps every environment consistent.
- The seven `STORAGE_S3_*` values from `.env.staging.local`. With them set,
  the app uses Supabase Storage; without them, it falls back to local disk,
  which doesn't persist on Vercel.
- `APP_BASE_URL`: the deployment's public URL, so QR codes on generated PDFs
  point at it.

Run migrations from a trusted machine with `npm run staging:migrate`, not
from the Vercel build.

## 6. Background tick: pg_cron + pg_net

The app's background work (domain-event dispatch, workflow timers; later the
MAR sweep) runs through `POST /api/cron/tick`, one bounded tick per call
(docs/WORKFLOW_SPINE_DESIGN.md §3). Vercel Hobby only allows a daily cron, so
on staging **Supabase calls the route every minute** with `pg_cron` + `pg_net`.

> **The one documented exception to "migrations own all extensions".**
> `pg_cron` and `pg_net` are enabled here, in the SQL editor, not by a Prisma
> migration: they are staging infrastructure that drives the app from outside,
> not part of the app's schema. The app never depends on them (locally,
> `npm run worker` does the same job), and no migration may reference them.
> Every extension the schema declares (`vector`) is still migration-only.

1. **Generate a secret** (at least 32 characters) and set it as `CRON_SECRET`
   in Vercel (staging environment) and in `.env.staging.local`. Never commit
   it. Without it the route answers 503.
2. **Store it in Supabase Vault**, not in the job text (SQL editor):
   ```sql
   select vault.create_secret('<the CRON_SECRET value>', 'aarogya_cron_secret');
   ```
3. **Enable the extensions and schedule the job** (SQL editor, staging only):
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   select cron.schedule(
     'aarogya-tick',
     '* * * * *',
     $$
     select net.http_post(
       url := 'https://<staging-host>/api/cron/tick',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'aarogya_cron_secret')
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 55000
     );
     $$
   );
   ```
   Overlapping calls are safe: claims use `FOR UPDATE SKIP LOCKED` and every
   consumer is idempotent.
4. **Check it runs** (after a few minutes):
   ```sql
   select status, return_message, start_time from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'aarogya-tick')
   order by start_time desc limit 5;
   select status_code, created from net._http_response order by created desc limit 5;  -- expect 200
   ```
   A 401 means the Vault secret and `CRON_SECRET` differ; a 503 means
   `CRON_SECRET` isn't set in Vercel. The platform event metrics
   (oldest pending event age) turn WARN/CRIT if the job stops.
5. **To stop it:** `select cron.unschedule('aarogya-tick');`

**Production (later):** Vercel Pro cron every minute, calling the same route
with the same `Authorization: Bearer` header. Nothing in the app changes.

## 7. Rules

1. **`verify:all` never targets staging.** The gates are destructive. Run
   them locally or in CI.
2. **Migrations own every extension,** including `vector`. Never enable
   extensions from the dashboard.
3. **Schema changes reach staging only through `staging:migrate`,** never
   through `prisma db push` and never through the dashboard SQL editor.
4. **Staging holds synthetic data only.**
5. **Secrets stay in `.env.staging.local` and in Vercel's encrypted
   environment variables,** never in git. This includes the S3 access keys.
6. **Buckets stay private.** Files leave storage only through short-lived
   signed URLs, and the S3 keys never reach the browser.
