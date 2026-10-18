# Pre-launch checklist

- **Status:** Open. Nothing here is done unless marked done with a date, an owner and evidence (a link, a document, a commit).
- **Date:** 2026-10-18
- **Rule:** the real-data switch (`AI_REAL_DATA_ENABLED`) stays off, and no real patient data enters any environment, until every item under *Blocking real data* is done.

## Blocking real data

| # | Item | What "done" means | Owner | Status |
|---|---|---|---|---|
| 1 | **Undo-merge (support-only)** | A support tool to reverse a Person merge from its snapshot (`PersonMergeRecord.snapshot`) and a facility merge (existing unmerge). Restricted to a platform support role, two-person (one requests with a reason code, a different one approves), fully audited, the person notified. A gate covers it, including refusal when either Person has changed since in a way the snapshot can't restore. | Engineering | Not started |
| 2 | **Clinical advisor sign-offs** | A named clinical advisor signs, in writing: (a) the sensitive-category list (`docs/RAG_DESIGN.md` §3.1, §5.3); (b) the document pipeline's fact types, exact-copy rules and conflict rules (`docs/DOCUMENT_PIPELINE_DESIGN.md`); (c) the evaluation answers for the pipeline (50 samples) and RAG (30 questions); (d) each AI mode's prompt and refusal rules; (e) the patient-facing wording of allergy and conflict notices. Every item marked "pending clinical advisor" in the docs is cleared. | Clinical advisor (not yet named) | Not started |
| 3 | **Data processing agreements** | Signed DPAs with every processor that receives patient text or images: Anthropic (OCR, translation, extraction, answers), the embeddings provider (Voyage or an India-hosted one), the email and SMS providers, object storage, the database host. Each with zero data retention where offered, no training on inputs, breach notification, sub-processor list, and deletion on termination. | Legal + engineering | Not started |
| 4 | **Lawyer review** | A written opinion covering: the DPDP Act 2023 and its rules (notice and consent per purpose, the person's rights, retention, breach reporting, the Data Protection Officer); **children's data** (verifiable guardian consent, no tracking or profiling, the turning-18 lapse); **telemedicine** (the Telemedicine Practice Guidelines for any video or advice feature; what the AI may never say); **cross-border transfer for AI processing** (whether Anthropic and Voyage processing outside India is permitted, and on what terms; when an India-hosted option is required). The product's consent texts and notices are approved by the lawyer. | Legal | Not started |
| 5 | **ABDM certification** | The ABDM sandbox and production integration certified (HIP/HIU as applicable; ABHA verification). Only then may `PERSON_ABHA_LINKING` be enabled and ABHA count as verified (`verifiedVia = ABDM_AUTH`). | Engineering + compliance | Not started |
| 6 | **Security audit** | An independent assessment (application penetration test and a configuration review) of: authentication and sessions; the person-identity flows (linking, the second factor, the staff-phone hold, in-person verification, merges, closure); tenancy (the sweep's guarantees); signed URLs and storage; the AI and pipeline prompts (injection); secrets handling. All high and critical findings fixed and re-tested. | External auditor | Not started |
| 7 | **Supabase staging run** | The full migration history applied to the Supabase (Mumbai) staging project by `prisma migrate deploy`; `npm run identity:migrate -- --dry-run` there first, then the real run, both reports kept; the seed for staging only; an end-to-end walkthrough on staging (sign-up, link, upload, review, merge, closure) with synthetic data; backups and restore tested once. verify:all is never run against staging. | Engineering | Not started |

## Also before launch (not blocking synthetic pilots)

| # | Item | Notes |
|---|---|---|
| 8 | **SMS outbox guard** | `SMS_PROVIDER=outbox` has no production guard yet, because the integrity gates start a production build (`next start`) with it. Add a guard that tells a gate run from a deployment (for example a gate-only flag that a deployment can't set), with a test. |
| 9 | **Demo credentials** | The seeded demo accounts share well-known passwords (`Hospital@123`, `Scholar@123`). Never seed them into staging or production; rotate any environment that ever had them. |
| 10 | **Commercial drug brand list** | Licensing decision after the pilot. Until then, brand names depend on model tagging. |
| 11 | **WHO INN full import** | The repository carries a curated starter set. The full, versioned INN list is imported from WHO's published cumulative list, with its list number recorded, and refreshed yearly. |
| 12 | **Document pipeline: real-provider evaluation** | `npm run eval:documents -- --provider real` (synthetic fixtures only; needs `DOCUMENT_AI_PROVIDER=claude` and a key) with its report recorded in the PR. First add a renderer that draws every script with handwriting fonts and noise: today's fixture PDFs draw Latin-script lines only, so a real run scores English pages meaningfully and the other scripts not at all. The CI run on the mocks proves gating and exactness, not model quality. **Renderer done (2026-10-18, engineering, branch `foundation/w4b-rag` step 2c: `src/lib/documents/fixtures/render.ts`, all eleven app languages incl. Odia and Urdu/Nastaliq).** The real run is `npm run eval:documents:real` (step 2d): **ready, not yet run** — on 2026-10-18 the key in `.env.local` was refused by the provider for insufficient credit, so no score exists yet. |
| 13 | **Document pipeline: image normalization** | Page images are not re-rendered (no orientation or resolution normalization): a PDF page is copied into its own PDF and an image upload is its own page. Add an image library and normalization before relying on phone photos. **Done (2026-10-18, engineering, branch `foundation/w4b-rag` step 2a: `src/lib/documents/normalize.ts`, gate `verify-postgres-image-normalization`).** PDF pages are still not rasterized (see the pipeline design §15.3). |

| 14 | **RAG: real-provider evaluation** | `npm run eval:rag:real` (synthetic only) with its report recorded in the PR; ≥ 90% correct with valid citations (docs/RAG_DESIGN.md §10.2). On 2026-10-18 the Anthropic key was refused for insufficient credit and there is no Voyage key: ready, not run. |
| 15 | **RAG: recalibrate the "no record" thresholds** | The per-mode thresholds (staff 0.50, patient 0.55) were calibrated on the offline reranker's scale. Recalibrate on the real reranker (Voyage or the India-hosted choice) with the evaluation, record the values, keep patient modes ≥ staff. |
| 16 | **RAG: the text-encryption key in a KMS** | Retained AI text uses `AI_TEXT_KEY_<version>` from the environment; without a key nothing is kept. Provision it from a KMS per environment, with rotation (`AI_TEXT_KEY_VERSION`) and access limited to the app. |
| 17 | **RAG: embeddings provider for real data** | Voyage refuses real data by code until the DPDP cross-border check (item 4) clears it, or an India-hosted provider is chosen (a re-embed job, no migration). |
| 18 | **RAG: proxies and share categories** | Proxies (family members) are refused until households (5b) add `USE_AI`; the visit code carries no category or date-range choice until 4c, so it never includes uploads or sensitive categories. |

## How to update this file

Change a row's status only with evidence. Write *Done (date, who, link)*, never just "done". Add new items rather than editing old ones away.
