# ADR 0005: RAG embeddings, the provider data policy, and which tables are new

- **Status:** Accepted (2026-11-17). Parts B and C are decided. Part A's decision is "adopt nothing until the Phase 1 benchmark has numbers"; the model itself will be chosen by a later ADR.
- **Date:** 2026-11-17
- **Context documents:** [`../RAG_AUDIT.md`](../RAG_AUDIT.md), [`../RAG_ARCHITECTURE.md`](../RAG_ARCHITECTURE.md), [`../RAG_DESIGN.md`](../RAG_DESIGN.md) §6.2 and §16.3.

## Context

The Week 4b build left three things undecided or implicit:

1. **Which embedding model serves real data.** The index runs on a deterministic mock (feature hashing, 1024 dimensions). Voyage is coded and refuses real data. An "India-hosted" slot exists and refuses everything.
2. **Which provider may receive real data.** One global switch covers all of them.
3. **Which tables the wider RAG scope needs.** The specification proposes seven new entities. Rule 1 for this work is to extend what exists.

Constraints that bound every option:

- Vercel for the app, Supabase Postgres in Mumbai (`ap-south-1`) with pgvector. No Redis, queue broker, vector database, second database or new service.
- Eleven app languages, ten of them Indic, one right to left.
- No protected health information to an external provider without an explicit per-provider flag, default off.
- The Anthropic account has no credit and there is no `VOYAGE_API_KEY`. Nothing can be measured against a real provider today.
- The real-data switch stays off. Synthetic data only.

---

## Part A: the embedding model

### A.1 What must be true of the model

| Requirement | Why |
|---|---|
| Good retrieval in ten Indic languages and English | The record and uploads are in the patient's language |
| **Cross-script retrieval** (a Latin query finds Devanagari text) | PostgreSQL cannot do this at all: measured word similarity 0.00 (`RAG_AUDIT.md` §11) |
| Query embedding fast enough for the 150 ms retrieval budget | The query is embedded on every request |
| Real data processed in India, or under a signed agreement and a recorded DPDP cross-border assessment | Rule 5; `RAG_DESIGN.md` §11.2 |
| Runs within Vercel and Supabase, or the exception is decided openly | Rule 6 |

### A.2 Options

Every figure below is labelled by where it comes from. **None was measured by us against Aarogya data,** because no key works and no self-hosted model has been run.

| | Mock (today) | Voyage (external API) | BGE-M3, self-hosted | multilingual-e5-large, self-hosted | multilingual-e5-small, inside the function |
|---|---|---|---|---|---|
| Status in the code | Active | Coded; refuses real data | Not built | Not built | Not built |
| Dimensions | 1024 | 1024 (`voyage-multilingual-2`) | 1024 | 1024 | 384 |
| Parameters | — | Not published | 568 million | 560 million | 118 million |
| Input limit | — | 32,000 tokens | 8,192 tokens | 512 tokens | 512 tokens |
| Weights on disk (32-bit) | — | — | About 2.2 GB | About 2.2 GB | About 0.47 GB |
| Licence | Ours | Commercial API | MIT | MIT | MIT |
| Indic quality, published | None: it hashes words, so it cannot match across scripts or inflections | Sold as multilingual; no per-language Indic figure found | MIRACL Hindi nDCG@10 59.3 (its paper; reproduced at 58.9 by a third party). Hindi-BEIR average nDCG@10 47.29 | Hindi-BEIR average 39.93 for mE5 (the size was not stated in the table found) | Lower than the large model by its authors' figures; no Indic figure found |
| Indic quality, measured by us | Baseline: 30/30 on an English-heavy set | **Pending** (no key) | **Pending** | **Pending** | **Pending** |
| Query latency | Under 1 ms, in process | A network call from Mumbai to a US endpoint; **not measured** | **Not measured.** A 568-million-parameter model on CPU is unlikely to meet the budget; it needs a GPU or a quantised build | The same | **Not measured.** Plausible on CPU; cold start loads the model |
| Cost | Zero | Listed at $0.12 per million tokens (`voyage-multilingual-2`), $0.05 per million for `rerank-2.5`; free allowances apply. From third-party price listings on 2026-11-17, to be confirmed on Voyage's own page | A machine, running always | The same | Function time and memory only |
| Where data is processed | In the app | Outside India. Europe and US residency was found in preview through MongoDB Atlas; **no India region was found** | Wherever we host it: Mumbai is possible | The same | In the Vercel function's region |
| Fits Vercel | Yes | Yes (an HTTPS call) | **No.** Vercel documents a 250 MB uncompressed function size; the weights are about nine times that | **No**, for the same reason | Unclear. About 120 MB when quantised to 8 bits, plus the runtime; near the limit, and unproven |
| Needs a new service | No | No | **Yes** | **Yes** | No |

What the cost row means at Aarogya's scale, using the listed prices and a 400-token chunk:

| Work | Tokens | Estimated cost with Voyage |
|---|---|---|
| Embedding 1 million chunks (an assumed corpus size, for scale) | 400 million | About $48, once |
| 1,000 queries embedded (about 20 tokens each) | 20,000 | Under $0.01 |
| 1,000 queries reranked (30 passages of about 450 tokens) | 13.5 million | About $0.68 |

So cost does not decide this. Residency and Vercel feasibility do.

### A.3 What the table shows

1. **No option meets every requirement.**
   - The models with published Indic strength (BGE-M3) cannot run inside a Vercel function, so they need one new service, which rule 6 forbids.
   - The option that needs no new service and has published multilingual claims (Voyage) processes data outside India and has no per-language Indic numbers we could verify.
   - The option that fits both rule 6 and residency (a small model inside the function) has no evidence of adequate Indic quality.
2. **The published numbers are not about our task.** MIRACL and Hindi-BEIR are Wikipedia and web passages. Ours are short clinical sentences with medicine names, units and mixed scripts. They indicate an order, not a result.
3. **Latency is unmeasured for every real option.**

### A.4 Decision

**Adopt nothing in Phase 0. The mock embedding space stays `ACTIVE`.**

1. **Phase 1 builds an Indic retrieval benchmark** (plan step 1.9): synthetic clinical sentences in all eleven languages, with four kinds of case per language: same script, inflected, transliterated, and cross-script. It runs any `EmbeddingProvider`, and reports recall@8, MRR and nDCG@10 per language and per kind, plus p50 and p95 query-embedding latency from the Mumbai region.
2. **A model is adopted only by a later ADR that quotes that benchmark's numbers** for every candidate it could run. The bar, set now so it cannot be fitted to a favourite afterwards:
   - recall@8 of at least 0.85 in each of the eleven languages on same-script and inflected cases;
   - cross-script recall@8 of at least 0.70 averaged over the ten Indic languages, and reported per language;
   - p95 query embedding, measured from Mumbai, low enough that the whole retrieval stays under 150 ms, or the retrieval budget is renegotiated openly with the measured figure;
   - a data-processing position that rule 5 accepts.
3. **Until then:**
   - Voyage may be used for synthetic-only evaluation when a key exists. Its refusal of real data stays, and becomes the per-provider flag of part C.
   - Cross-script retrieval is claimed only for medicine names, through canonical names added as index terms (architecture §10.2). Everything else cross-script is reported as not supported.
   - No vector column or index is tied to a dimension. `RagEmbedding` is untyped half precision, so the eventual model is a re-embed job, not a migration.

### A.5 The recommendation, with its condition

If the benchmark's order matches the published one, the recommendation will be **BGE-M3, self-hosted in `ap-south-1`**, for real data: it is the only candidate here with published Indic results, an 8,192-token input limit, a permissive licence, and processing in India with no cross-border transfer.

That recommendation **requires an exception to "no new services"**: one stateless embedding container, behind the existing `EmbeddingProvider` adapter, with the mock as the default and the container enabled only by environment (ADR 0003). It is not assumed: the product owner decides after the Phase 1 benchmark (decided 2026-11-17).

If the exception is refused, the fallbacks in order are:

1. the small model inside the function, **if** the benchmark shows it meets the bar;
2. an external provider under a signed agreement and a recorded cross-border assessment, with its flag turned on deliberately;
3. keyword and structured retrieval only for real data, with semantic search left to synthetic demonstrations. This is safe and honest, and weaker for free-text questions in Indic languages.

A managed embedding service hosted in an Indian cloud region may also exist. None was verified in this audit, so none is listed as an option; the benchmark harness can run one if you name it.

### A.6 The reranker

The same reasoning applies. Today the mock reranks with BM25 and Voyage's `rerank-2` is coded. A cross-encoder reranker is a second model with the same residency and hosting questions. The benchmark reports results with and without a reranker, so that "no reranker for real data" can be chosen on evidence if hosting one is not acceptable.

---

## Part B: tables

The rule: a new table only where an existing one cannot be extended, with the reason written down.

### B.1 Extended

| Existing | Change | Reason |
|---|---|---|
| `RagOwnerType` | Add `KNOWLEDGE` | A third kind of owner, beside a facility's patient and a person |
| `RagOrigin` | Add `IMPORTED` | Imported legacy results must be labelled and must never count as verified |
| `RagSourceType` | Add `KNOWLEDGE_DOCUMENT`, `LEGACY_LAB_RESULT` | New sources |
| `RagDocumentStatus` | Add `PENDING` | A knowledge version's chunks are written before it is approved and published; retrieval already admits only `ACTIVE` |
| `RagDocument` | Organisation and facility already exist. Add the knowledge version it indexes | Version-aware retrieval |
| `RagChunk` | Add organisation, access class, page number, section path, an English text-search column, a trigram index | Filters must be on the row being ranked; citations need page and section |
| `RagEmbedding` | The same filter columns, copied by the existing trigger | The vector search filters on the embedding row alone |
| Owner CHECKs on all three | A `KNOWLEDGE` row has an organisation and no patient or person; the others have no access class | The owner kind is never ambiguous |
| `AiInteraction` | Add module, intent, tier, provider, embedding tokens, rerank units, estimated cost, cache-hit flags, retrieval and generation latency | Usage and cost accounting |

### B.2 New

| New table | Why no existing table works |
|---|---|
| **`KnowledgeDocument`** | No model holds a reference document owned by an organisation or facility. `ClinicalDocument` and `GeneratedDocument` belong to a patient and encounter; `PersonDocument` belongs to a person. Putting an SOP in any of them would need its patient or person columns to be null and its access rules to be bypassed. |
| **`KnowledgeDocumentVersion`** | Approval, effective and expiry dates, the superseded-by link, the file's hash and the ingestion status are per version. `RagDocument` is derived data that is rebuilt and whose chunks are hard-deleted; the authoritative version history cannot live in a table that is thrown away on a re-index. |
| **`AiInteractionSource`** | `AiInteraction.retrievedChunkIds` and `citedChunkIds` are arrays of ids. They cannot carry rank, document version, page or section, and an id stops resolving when its chunk is deleted on supersede. Attribution that lasts a year needs a row per source, with no text in it. |
| **`AiEmbeddingCache`** | A vector keyed by embedding space and content hash, for knowledge text. `RagEmbedding` is keyed by chunk, so identical text in two documents is embedded twice. Holds a hash and a vector, never text. |

### B.3 Proposed by the specification and not created

| Specification entity | Decision | Reason |
|---|---|---|
| `KnowledgeChunk` | Not created | `RagChunk` is extended. A second chunk table would need its own embedding table, embedding-space handling, re-embed job, copy trigger and latency gate. |
| `EmbeddingJob` | Not created | The transactional outbox, the bulk lane, `runTick` and `RagBackfillCursor` already are the job system, with retries, dead letters and replay. Ingestion state is on the version row. |
| `RAGQueryLog` | Not created | `AiInteraction` already is it, with retention and review built. |
| `RAGSourceReference` | Created as `AiInteractionSource` | Named after the model it belongs to. |
| `AIConversation`, `AIConversationMessage` | **Not created** (decided 2026-11-17) | No server-side conversations in these phases. The client keeps recent turns and sends a compact context. Stored turns would be retained patient text. |

### B.4 The alternative considered for knowledge chunks

**A separate `KnowledgeChunk` and `KnowledgeEmbedding`.** It keeps non-patient rows physically apart from patient rows, so no predicate ever has to tell them apart.

Rejected, because:

- it duplicates the embedding-space and re-embed machinery, and a switch of model would need two coverage counts to reach 100% in one transaction;
- the separation it buys is also achieved by a CHECK on the owner kind and by never putting a patient segment and a knowledge segment in one candidate query;
- the leak gate can prove the second and cannot make the first cheaper.

The risk accepted: one more owner kind in the tables that hold clinical text. It is controlled by the CHECKs, by separate candidate queries, and by leak-gate canaries in both directions (threat T-R01).

### B.5 Migration rules for these changes

- Enum values first, in their own migration.
- Every new CHECK is added `NOT VALID`, then validated; if validation finds a row, the migration stops and names it. It does not repair the row.
- No existing column is dropped or retyped.
- All five Phase 1 migrations are written after PR #16 merged (2026-11-17), because it changed the same schema file.

---

## Part C: the provider data policy

### C.1 Decision

Real data reaches a provider only when **both** hold:

1. `AI_REAL_DATA_ENABLED=true` (exists; off);
2. that provider's own flag, `AI_PHI_ALLOWED_<PROVIDER>=true` (new; **off by default for every external provider**).

The check is made inside each provider, at the same place it asserts its permit, so no caller can route around it. Voyage's hard-coded refusal is replaced by its flag, which stays off.

A provider's flag is turned on only after `PRE_LAUNCH_CHECKLIST.md` records, for that provider: a data-processing agreement with zero retention and no training on inputs; a DPDP cross-border assessment, or processing in India; the Data Protection Officer's sign-off.

### C.2 Knowledge documents

They contain no patient identifiers but may be confidential to the hospital. Sending them to an external provider is governed by a separate per-organisation setting, default off. An upload containing anything that looks like a patient identifier is refused (both decided 2026-11-17).

### C.3 Provider families stay separate

The Scholar and assistant family, the record-answer family, the embeddings family and the document family keep their own interfaces and permits. Routing between models and providers is added inside the record-answer family. The specification's instruction to extend the existing `AIProvider` is read as "extend the provider boundary in `src/lib/ai`", because merging the families would remove the separation that keeps Scholar code away from patient data.

---

## Consequences

- **Nothing changes in production behaviour from this ADR.** The mock stays active; the switch stays off.
- **Phase 1 carries a benchmark** that would otherwise be optional. Without it, the model choice would rest on other people's datasets.
- **Semantic retrieval over real data in Indic languages has no approved path yet.** That is stated in the plan and the threat model, and it blocks the real-data switch (which several other things also block).
- **Two new table groups, one cache table.** Each joins the tenancy sweep, the facility-consistency gate and the emit rule.
- **One more owner kind in the index.** Paid for with CHECKs and leak-gate canaries.
- **A later ADR will supersede part A** with the benchmark's numbers. This one is not rewritten.

## Sources for the figures in part A

Retrieved on 2026-11-17. Third-party price listings and partial benchmark tables are marked as such above; each is to be confirmed at its primary source before any adoption.

- Voyage pricing: [Voyage AI pricing documentation](https://docs.voyageai.com/docs/pricing); [Costbench listing](https://costbench.com/software/embedding-apis/voyage-ai/); [Bifrost model library](https://www.getmaxim.ai/bifrost/model-library/provider/voyage).
- Residency: [MongoDB: Europe data residency for Atlas embedding and reranking](https://mongodb.com/company/blog/product-release-announcements/europe-data-residency-for-atlas-embedding-reranking).
- BGE-M3 on MIRACL Hindi: [miniMiracle_hi_v1 model card, quoting the BGE-M3 paper](https://huggingface.co/prithivida/miniMiracle_hi_v1).
- Hindi-BEIR: [Hindi-BEIR: A Large Scale Retrieval Benchmark in Hindi](https://arxiv.org/pdf/2408.09437).
- Vercel function size: [Vercel Functions limits](https://vercel.com/docs/functions/limitations).
- Model sizes, input limits and licences: the models' own cards (BAAI/bge-m3, intfloat/multilingual-e5-large, intfloat/multilingual-e5-small). Not re-fetched in this audit.

## Addendum, 2026-11-24: the price table, checked (RAG Phase 5, step 3e)

**Status: checked, pending owner confirmation.** Every price in `src/lib/rag/prices.ts` (the per-request cost estimate and the usage report) was read on its provider's own pricing page on **2026-11-24**. They are list prices in US dollars; the account's actual rates (credits, discounts, the Haiku long-prompt band, data-residency multipliers) are for the product owner to confirm, and `confirmed` stays `false` until then.

| Item | Price in the table | Source (checked 2026-11-24) | Finding |
|---|---|---|---|
| Claude Sonnet 5.5 (`claude-sonnet-5-5`), every record and knowledge mode | $2 / MTok input, $10 / MTok output | [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) | Matches. Cache hits $0.10 / MTok (0.05×) are not used: no prompt is long enough to cache. |
| Claude Haiku 5.5 (`claude-haiku-5-5`), the document helpers | $0.10 / MTok input, $0.50 / MTok output | same page | Matches, for prompts up to 100,000 tokens ($0.50 / $2.50 above that; no AI request here comes near it). |
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 / MTok input, $20 / MTok output | same page | Matches. Not used by any mode. |
| Voyage `voyage-multilingual-2` (embeddings) | $0.12 / MTok | [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing) (page dated 2026-09-29) | Matches. The page lists it among older models, and contradicts itself on whether its 50 million free tokens apply. |
| Voyage `rerank-2.5` | $0.05 / MTok | same page | **Corrected.** The table priced reranking per thousand documents; Voyage bills tokens: query tokens × documents + the documents' tokens. The estimate now counts each document scored as the query's tokens plus a 400-token chunk. 200 million free tokens may apply (the page contradicts itself). |

The mock providers are priced as the model they stand in for, so the estimate shows what a request would cost on the configured provider. No real provider call was made (no credit, no Voyage key).
