# Feature Buildout Log

A running, phase-by-phase record of the functional buildout described in the
buildout brief. Each entry states what was built, entitlements added, env vars
needed, and what was deliberately deferred (and why). Newest phase appended last.

Conventions followed every phase: server-validated logic with Vitest tests,
facility tenant scoping, RBAC + `recordAuditEvent` on writes and PHI reads,
adapter interfaces for external providers (dev impl + real impl gated on env
creds, never faked), entitlement gates server-side, money as minor units, paired
migrations in `prisma/migrations` and `prisma/migrations-postgres-baseline`.

---

## Phase 1.1 — Object storage (`src/lib/storage/`)

**Built.** A single `StorageAdapter` boundary every binary consumer (clinical
documents, verification uploads, generated PDFs, patient uploads) reads/writes
through, following the existing verification-provider pattern:

- `LocalDiskStorageAdapter` (default, always available): writes to a gitignored
  `.data/object-store/` outside `public/`, never served statically. Downloads go
  through a short-lived HMAC-signed capability token (`token.ts`, signed with
  `AUTH_SECRET`, TTL clamped to 30 s–15 min) served by `GET /api/storage/download`.
- `S3StorageAdapter` (S3 / Cloudflare R2 / MinIO): activates **only** when the
  `STORAGE_S3_*` env credentials all exist; otherwise it is never selected — the
  unconfigured provider is dormant, not faked. Uses provider-native presigned
  URLs. AWS SDK is dynamically imported so the local path never loads it.
- `validation.ts`: per-bucket size ceilings + content-type allow-list + magic-byte
  sniffing that must agree with the declared MIME (blocks type smuggling). Buckets:
  `clinical-documents`, `verification`, `reports`, `patient-uploads`, `generated-pdf`.
- `ref.ts`: logical `storageRef` (`<bucket>/<scope?>/<sha16>-<safeName>`) with
  traversal/absolute/backslash/unknown-bucket rejection; local adapter additionally
  refuses any resolved path escaping the store root.

**Tests.** `src/lib/storage/storage.test.ts` — 19 tests: sniffing, validation
(empty/oversize/disallowed/smuggling), filename+scope sanitisation, ref safety,
token round-trip/tamper/expiry/clamp, local put/get/delete round-trip, signed-URL
token resolution, and default adapter selection.

**Entitlements added.** None (foundation; consumers gate their own features).

**Env vars added** (`.env.example`, all optional — local disk is the default):
`STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`,
`STORAGE_S3_SECRET_ACCESS_KEY`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_KEY_PREFIX`,
`STORAGE_S3_FORCE_PATH_STYLE`.

**Dependencies added.** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

**Deferred (with reason).**
- Wiring `ClinicalDocument.storageRef`, report attachments and verification
  uploads onto this adapter — done as those features are (re)built in later
  sub-phases, to keep 1.1 a self-contained, independently-tested foundation.
- Virus/malware scanning — belongs to an external AV provider behind its own
  adapter when procured; `validation.ts` is the honest always-on floor and never
  claims to have scanned.
- Per-download audit in the route: downloads are authorised by a capability token
  minted only from already-audited endpoints (mirroring how S3 presigned URLs
  work); the PHI-read audit belongs at issuance, added per consumer.

**Gate.** `npm test` 941 passing (+19), `npm run build` green, lint clean for new files.

---

## Phase 1.2 — PDF document generation + authenticity verification

**Built.** Server-side PDF generation (pure-JS `pdf-lib`, no headless browser),
plus a public QR-based authenticity check.

- `src/lib/documents/pdf/primitives.ts` — A4 geometry, wrapped text, key/value
  rows, tables, embedded QR (`qrcode`), diagonal DRAFT watermark, "Page N of M"
  footers.
- `src/lib/documents/pdf/layout.ts` — a data-only `DocumentSpec` (letterhead,
  title, meta, typed sections, verify URL) rendered to PDF bytes. Keeping it
  data-only makes templates testable without pdf-lib.
- `src/lib/documents/templates.ts` — all 12 document types as compact, pure
  builders: prescription, OPD summary, discharge summary, lab report, radiology
  report, tax invoice/receipt (GST, HSN/SAC), refund note, claim packet,
  certificate (fitness/medical/sick-leave), referral letter, death certificate
  (Form 4/4A), birth record. Money is always MINOR units, formatted as `Rs.`
  (the standard PDF fonts are WinAnsi and cannot encode the ₹ glyph without
  embedding a full Unicode font).
- `src/lib/documents/service.ts` — `generateAndStoreDocument`: render → store in
  the `generated-pdf` bucket (Phase 1.1) → `GeneratedDocument` row with sha256 +
  unguessable `verifyToken` → `recordAuditEvent("hospital.document.created")` →
  return a signed download URL.
- `src/lib/documents/verify.ts` + `/verify/[token]` public page — confirms
  authenticity showing ONLY non-PHI facts (title, facility, document no., issue
  date, draft flag). `toPublicVerification` is pure and asserted to leak no PHI.

**Model + migrations.** New `GeneratedDocument` model (facility-scoped, `type`
TEXT enforced in code) with paired migrations in `prisma/migrations` and
`prisma/migrations-postgres-baseline` (`20260930090000_phase_1_2_generated_documents`).
Applied to dev.db via `prisma migrate deploy`.

**Tests.** `src/lib/documents/documents.test.ts` — 24 tests: type guard, INR
formatting, a spec built + rendered for every one of the 12 templates, invoice
subtotal+tax math, %PDF header, multi-page pagination, public-projection PHI
safety, and service helpers (doc numbers, token uniqueness, verify URL).

**Entitlements added.** None (foundation; feature surfaces gate themselves).

**Env vars added.** `APP_BASE_URL` (absolute base for scannable QR verify links;
defaults to `http://localhost:3000`).

**Dependencies added.** `pdf-lib`, `qrcode`, `@types/qrcode` (dev).

**Deferred (with reason).**
- Replacing the mock `/prescriptions/[id]` page — its DB-backed source (a real
  prescription assembled from the doctor Rx flow) is built in Phase 2; the PDF
  template + service are ready to back it then. Not faked against mock data now.
- Facility letterhead logo image + address from the D8 config engine: the
  service already accepts a `Letterhead`; the config-key wiring lands with the
  Phase 8 configuration UI. Author name/registration and facility name flow
  through today.

**Gate.** `npm test` 965 passing (+24), `npm run build` green, lint clean for new files.
