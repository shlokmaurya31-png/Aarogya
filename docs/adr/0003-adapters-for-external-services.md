# ADR 0003: Every external service sits behind an adapter, switched on by env

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

Aarogya depends on, or will depend on, services it doesn't run: object
storage, the LLM, payments, email, shared rate limiting, ABDM, NHCX and PACS.
Each one has three problems:

- **Development and CI need to work without it.** Contributors and CI jobs
  have no credentials, and the integrity gates must not call real providers.
- **Some of them can't be reached yet.** ABDM, NHCX and PACS need contracts,
  sandboxes or specifications we don't have. Code has to be written up to the
  boundary without pretending the other side exists.
- **Providers change.** Storage moved from local disk to Supabase Storage
  ([ADR 0002](0002-supabase-mumbai-staging.md)) without any change to the
  calling code, because the code depends on `StorageAdapter` and not on S3.

The pattern already existed in several places. Connecting Supabase Storage
through the existing S3 adapter, without touching any caller, confirmed it
works. This ADR makes it the rule.

## Decision

**Every external service is reached through an interface in `src/lib`, with
at least two implementations:**

1. **A dev/mock implementation** that is always available and needs no
   credentials. It is honest:
   - it really does the work locally (local disk, a console outbox, in-memory
     counters); or
   - it is clearly synthetic (a mock AI reply); or
   - it refuses (`NOT_IMPLEMENTED`, or throwing in production).

   It **never reports success for something that didn't happen.**
2. **One or more real implementations,** switched on **only by environment
   variables.** If the variables are missing, the real implementation is
   never selected. Code doesn't branch on `NODE_ENV` to pick a provider.

**Rules:**

- **Callers get the implementation from a single factory**, such as
  `getStorageAdapter()` or `getAIProvider()`. Code outside the adapter
  directory never imports a provider SDK.
- **Provider SDKs are imported dynamically inside the real implementation,**
  so the default path never loads them.
- **The selection is decided by env and can be inspected,** for example
  `activeStorageProviderName()`. A partial configuration falls back to the dev
  implementation, or, where a silent fallback would be dangerous (billing),
  throws.
- **Provider quirks stay inside the adapter as env-controlled options,** not
  as `if (provider === "supabase")` in calling code. Example: Supabase's S3
  differences are `STORAGE_S3_FORCE_PATH_STYLE`,
  `STORAGE_S3_BUCKET_PER_LOGICAL` and `STORAGE_S3_CHECKSUMS`.
- **Every real implementation has a check script that exercises it end to
  end** against the configured target (for example `storage:check`). The
  automated tests and gates run against the dev implementation.
- **Credentials live only in env:**
  - `.env` / `.env.local` locally;
  - `.env.staging.local` for staging;
  - Vercel's encrypted variables for deployments.

  They never go into git and are never printed.

## Current adapters

| Service | Interface / factory | Dev implementation | Real implementation, switched on by |
|---|---|---|---|
| Object storage | `StorageAdapter` / `getStorageAdapter()` (`src/lib/storage`) | Local disk outside `public/`, with HMAC-signed download tokens | S3 / R2 / MinIO / Supabase Storage: `STORAGE_S3_*` |
| AI | `AIProvider` / `getAIProvider()` (`src/lib/ai`) | `MockAIProvider` | Anthropic: `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` |
| SaaS billing | `src/lib/billing/provider` | `NONE`: every call throws, so no payment is ever faked | Razorpay: `BILLING_PROVIDER=RAZORPAY` + `RAZORPAY_*` |
| Email | `sendEmail()` (`src/lib/email/send.ts`) | Console outbox in development; not sent, and logged, in production | Resend: `RESEND_API_KEY` + `EMAIL_FROM` |
| Rate limiting | `src/lib/auth/rateLimit.ts` | In-process counters | Upstash Redis: `UPSTASH_REDIS_REST_*` |
| ABDM | `src/lib/hospital/interoperability/adapters` | `mockAbdm.ts` | `abdm.ts`: `ABDM_ENVIRONMENT` + `ABDM_*` |
| Clinical case data | `src/lib/clinical/provider.ts` | Synthetic cases | `CLINICAL_DATA_MODE` |
| NHCX | `src/lib/hospital/nhcx/adapter.ts` | Boundary only: returns `NOT_IMPLEMENTED` | None yet; no primary-source specification |
| PACS | `PacsAdapter` (`src/lib/hospital/pacsAdapter.ts`) | Deterministic no-op that never claims images exist | None yet |

**Known divergence.** `src/lib/verification/provider.ts` (student
verification documents) predates `StorageAdapter` and keeps its own
local-disk store. It follows this pattern but hasn't moved onto
`StorageAdapter`, so it doesn't use S3 yet. Moving it is follow-up work.

## Consequences

**Benefits**

- `npm run setup` and CI need no third-party accounts. The integrity gates
  are deterministic and never reach a real provider.
- Staging or production turns on a real provider by setting env variables,
  with no code change. Staging storage was done this way.
- Providers can't leak into business logic, so changing one later (R2
  instead of Supabase, or another LLM) is confined to one directory.
- Unbuilt integrations are visible as boundaries that refuse, not as code
  that pretends to work.

**Costs and risks**

- **The mock implementation can drift from the real service's behaviour.**
  Mitigated by the per-adapter check scripts, run against staging.
- **Env-only switching makes a missing variable silent:** the app falls back
  to the dev implementation. On Vercel that means, for example, files written
  to an ephemeral disk. Mitigated by:
  - each factory exposing which implementation is active;
  - documenting every variable in `.env.example` (and
    `.env.staging.example`);
  - throwing instead of falling back where a fallback would be unsafe.
- **Each new service costs a little more up front:** an interface, a mock and
  a check script.
