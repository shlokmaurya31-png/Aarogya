# Staging database: Supabase (Mumbai, ap-south-1)

Staging runs on a Supabase Postgres project in **ap-south-1 (Mumbai)**, so
patient-shaped data stays in India. ADR
[0002](adr/0002-supabase-mumbai-staging.md) records why.

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

## 4. Point Vercel at staging

When a deployment should use staging, set these in the Vercel project's
environment variables, for the Preview environment or whichever one is
staging:

- `DATABASE_URL`: the transaction pooler URL, with `?pgbouncer=true`.
- `DIRECT_URL`: the session pooler URL. The app doesn't use it at runtime,
  but it keeps every environment consistent.

Run migrations from a trusted machine with `npm run staging:migrate`, not
from the Vercel build.

## 5. Rules

1. **`verify:all` never targets staging.** The gates are destructive. Run
   them locally or in CI.
2. **Migrations own every extension,** including `vector`. Never enable
   extensions from the dashboard.
3. **Schema changes reach staging only through `staging:migrate`,** never
   through `prisma db push` and never through the dashboard SQL editor.
4. **Staging holds synthetic data only.**
5. **Secrets stay in `.env.staging.local` and in Vercel's encrypted
   environment variables,** never in git.
