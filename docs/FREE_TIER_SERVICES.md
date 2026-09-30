# Free-Tier Service Adoption Guide

> Curated from [ripienaar/free-for-dev](https://github.com/ripienaar/free-for-dev),
> filtered against Aarogya's actual stack (Next.js 16 on Vercel, Prisma +
> SQLite→Postgres, Anthropic AI, Capacitor Android via CodeMagic, ABDM interop,
> Razorpay boundary, Phase E1 Notification Center, D-phase SaaS layers).
>
> **Nothing here is integrated yet.** Each entry is a ~15-min task *after* you
> create the account and obtain credentials. Follow the existing **provider
> boundary** pattern (see `src/lib/ai/provider.ts`, `src/lib/clinical/config.ts`,
> `src/lib/verification/provider.ts`): the code depends on an interface, an env
> var selects the adapter, and an unset key falls back to a safe mock — never a
> hard fail.

## ⚠️ Data-residency gate (read first)

Almost every free tier below hosts data **outside India**. For **dev/staging**
that is acceptable. For **production with real PHI / ABHA identity data** under
the **DPDP Act + ABDM**, only adopt services that are **self-hostable** or offer
an **India region**. Those are flagged `🇮🇳-ok` (India region / self-host)
vs `🌍-review` (offshore, needs a residency decision) below.

---

## Priority order

| # | Category | Recommended pick | Blocks on |
|---|----------|------------------|-----------|
| 1 | Production Postgres | **Neon** | account + `DATABASE_URL` |
| 2 | Error tracking | **Sentry** (or self-host GlitchTip) | DSN |
| 3 | Transactional email | **Resend** | API key + verified domain |
| 4 | SMS / WhatsApp / OTP | **Pingram.io** | API key |
| 5 | Notification backend | **Novu** (self-host) | instance + API key |
| 6 | Object storage | **Neon storage** or **Cloudinary** | bundled / API key |
| 7 | Uptime + heartbeat | **healthchecks.io** / **Better Stack** | ping URLs |
| 8 | Log aggregation | **Axiom** | Vercel integration |
| 9 | APK test distribution | **Diawi** / **Loadly** | manual upload |
| 10 | Analytics | **Aptabase** (mobile) / **PostHog** | key |

Do them top-down; 1 and 2 give the fastest payoff.

---

## 1. Production Postgres — **Neon** `🇮🇳-ok`

- **Free:** 0.5 GB/project, 100 projects, 10 branches each, scales to zero,
  **plus 5 GB S3-compatible object storage that branches with the DB.** India region available.
- **Why:** you're on SQLite for dev; production needs managed Postgres. Branching
  maps onto your per-phase PG integrity-gate workflow.
- **Plug-in:**
  1. `prisma/schema.prisma` → set `datasource.provider = "postgresql"`.
  2. `.env` → `DATABASE_URL="postgresql://…@…neon.tech/…?sslmode=require"`.
  3. `npx prisma migrate deploy` against the Neon branch.
- **Alt:** **Prisma Postgres** (tightest ORM fit, 500 MB / 5 DBs) · **Aiven** (1 GB PG).

## 2. Error tracking — **Sentry** `🌍-review` / **GlitchTip** `🇮🇳-ok (self-host)`

- **Free:** Sentry 5k errors/mo, 1 user. GlitchTip is Sentry-SDK-compatible and self-hostable (keeps PHI in-house).
- **Plug-in:** `npx @sentry/wizard@latest -i nextjs` → sets up `sentry.*.config.ts`
  and `instrumentation.ts`. Point the DSN at GlitchTip instead if self-hosting.
- **Env:** `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`.
- **Alt:** **Bugsink** (self-host) · **Rollbar** (5k/mo).

## 3. Transactional email — **Resend** `🌍-review`

- **Free:** 3,000 emails/mo, 100/day, 1 custom domain. Next.js-native.
- **Why:** `ADMIN_EMAIL` notifications, verification, alerts — nothing wired today.
- **Plug-in:** new `src/lib/email/provider.ts` (interface + `resend` adapter + `mock`
  adapter). Selector env `EMAIL_PROVIDER=resend|mock`.
- **Env:** `RESEND_API_KEY`, `EMAIL_FROM`.
- **Alt:** **Brevo** (9k/mo) · **MailerSend** (500/mo) · **Postmark** (100/mo).

## 4. SMS / WhatsApp / OTP — **Pingram.io** `🌍-review`

- **Free:** SMS + **WhatsApp** + Push + Email in one tier (100 SMS/calls, 3,000 email).
- **Why:** critical for Indian patient OTP / ABHA flows; WhatsApp is the dominant channel.
- **Plug-in:** `src/lib/sms/provider.ts` (interface + adapter + mock),
  `SMS_PROVIDER=pingram|mock`. Route ABHA/patient OTP through it.
- **Env:** `PINGRAM_API_KEY`.
- **Phone validation:** **veriphone** (1,000/mo) or **numverify** (100/mo) as a
  separate `src/lib/phone/validate.ts`.
- **Alt:** **Courier** / **knock.app** (10k msgs/mo multi-channel).

## 5. Notification backend — **Novu** `🇮🇳-ok (self-host)`

- **Free:** open-source, self-hostable, 30k notifications/mo; unifies Email/SMS/In-App/Push.
- **Why:** you already **built** the Phase E1 Notification Center — Novu is a
  drop-in delivery backend behind it, self-hostable so PHI stays in-house.
- **Plug-in:** implement the E1 dispatch boundary against Novu's API; keep the
  existing ownership-scoped auth in front.
- **Env:** `NOVU_API_KEY`, `NOVU_BACKEND_URL`.
- **Alt:** **SuprSend** / **knock.app** (hosted, 10k/mo, digests/batching).

## 6. Object storage (verification documents) — **Neon storage** `🇮🇳-ok` / **Cloudinary** `🌍-review`

- **Why:** `src/lib/verification/provider.ts` stores documents out-of-band — needs a real blob backend.
- **Neon storage:** free if you adopt Neon (#1); one vendor, S3-compatible.
- **Cloudinary:** 25 credits/mo, on-the-fly image transforms for ID/medical images.
- **Plug-in:** implement the verification storage boundary against the chosen S3 API.
- **Env:** `STORAGE_PROVIDER`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.
- **Alt:** **ImageKit** (20 GB bandwidth) · **uploadcare** (3 GB).

## 7. Uptime + heartbeat monitoring — **healthchecks.io** `🇮🇳-ok (self-host)` / **Better Stack** `🌍-review`

- **Free:** healthchecks.io 20 checks; Better Stack 10 monitors + status pages.
- **Why:** your dispatchers/timers are deliberately **daemon-free / no cron** —
  heartbeat monitors confirm the outbox dispatcher & timer sweeps actually ran.
- **Plug-in:** ping the check URL at the end of each dispatcher/timer sweep.
- **Env:** `HEALTHCHECK_PING_URL_*` per job.

## 8. Log aggregation — **Axiom** `🌍-review`

- **Free:** 0.5 TB, 30-day retention, **native Vercel integration**.
- **Plug-in:** add the Vercel → Axiom log drain; no code change.
- **Alt:** **Grafana Cloud** · **openobserve** (self-host).

## 9. Mobile CI & APK distribution (Capacitor Android)

- **CI:** **CodeMagic** (already in `codemagic.yaml`, 500 min/mo) — keep. **Bitrise**
  (200 builds/mo) is the fallback if you outgrow it.
- **Distribution:** **Diawi** / **InstallOnAir** / **Loadly** — hand debug APKs to
  testers without the Play Store. Add an upload step to the CodeMagic workflow's
  `artifacts` stage.

## 10. Analytics (privacy-friendly) — **Aptabase** `🌍-review` / **PostHog** `🇮🇳-ok (self-host)`

- **Aptabase:** privacy-first mobile/app analytics (React Native/Flutter SDKs) — fits the Capacitor app. 20k events/mo.
- **PostHog:** product analytics + feature flags + surveys, 1M events/mo, self-hostable.
- **Web-only alt:** **Umami** / **GoatCounter** (cookieless, self-host).
- **Note:** for health data prefer cookieless + self-host; never send PHI in event payloads.

---

## Situational (adopt only if the need lands)

- **RevenueCat** / **Adapty** — mobile in-app subscriptions. Only if the Capacitor
  app sells subscriptions directly (vs. your web Razorpay path).
- **Logto** / **Stytch** — passwordless/OTP auth. Only if you replace the custom
  HMAC session layer (`src/lib/auth/session.ts`) — unlikely given ABDM coupling.

---

## What needs *your* action before any code lands

1. Create accounts and generate keys for the services you approve (I can't sign up for you).
2. Decide `🌍-review` vs `🇮🇳-ok` for anything that will touch **real** PHI in production.
3. Verify each domain (email) / region (Postgres, storage) before go-live.

Once you drop the keys into `.env`, ping me per service and I'll wire the adapter
+ mock fallback + `.env.example` entry, following the existing provider-boundary pattern.
