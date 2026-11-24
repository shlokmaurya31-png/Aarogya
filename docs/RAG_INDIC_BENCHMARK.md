# Indic retrieval benchmark: results (RAG Phase 1)

- **Run:** 2026-11-17, `npm run eval:rag:indic` (harness: `scripts/eval-rag-indic.ts`, data: `eval/rag/indic/dataset.ts`).
- **Purpose:** the numbers ADR 0005 part A asked for before any embedding model is adopted. This is not that decision: the product owner decides after reading this (plan §13, decision 2).
- **Data:** 44 synthetic clinical lines (four conditions, each with its medicine and dose, in eleven languages) and 236 queries. **Written by the engineering team, not reviewed by native speakers or a clinician.** No patient data.
- **Local models:** BGE-M3 and multilingual-e5-large were downloaded from the Hugging Face hub and run on this machine (Apple M2 Pro, 16 GB) by `scripts/indic-embed.py`, in a throwaway virtualenv. Nothing was sent to any service.
- **Voyage:** **pending** (no `VOYAGE_API_KEY`).

## How to read it

- Each query has one relevant line: the same condition in the target language.
- Cells are Recall@5 / Recall@10 / MRR / nDCG@10.
- **The corpus is tiny (44 lines).** It shows whether a method can match a kind of query at all. It does not show ranking quality at scale.
- **Cross-script and Latin-medicine queries are the same text for every language** ("diabetes", "metformin"). The other languages' lines about that condition are not wrong answers, but they compete for the top 5. So Recall@5 for these kinds is capped near 5/11, and Recall@10 is the fairer column.
- **Latency below is per query on this corpus**, not production latency. The production retrieval budget (p95 < 150 ms at 20,000 chunks) is held by `verify-postgres-rag-latency`.

## A bug the benchmark found, and its fix

The first run gave **keyword Recall@5 = 0.18** on same-script Indic queries. Query words were split on any character that isn't a letter or digit, and Indic vowel signs and viramas are combining marks (`\p{M}`). So "मधुमेह" reached Postgres as "मधमह" and matched nothing; only Urdu, which has few combining marks, worked.

Fixed in `orTsQuery` and `contentWords`: marks and zero-width joiners are now part of a word. Same-script keyword Recall@5 is now **1.00** in all eleven languages, and `verify-postgres-rag-indic` holds that floor in CI.

The offline mock embedder still splits on marks. It does so the same way for documents and queries, so its vectors still match each other, and it is a test double only. Changing it would change every mock vector already stored, so it is left for a re-embed (noted in the plan).

## Results after the fix

## By method and kind of query (Recall@5 / Recall@10 / MRR / nDCG@10)

| Method | SAME_SCRIPT | INFLECTED | TRANSLITERATED | MIXED_SCRIPT | CROSS_SCRIPT | MEDICINE_LATIN | All |
|---|---|---|---|---|---|---|---|
| keyword | 1.00 / 1.00 / 1.00 / 1.00 (n=44) | 0.00 / 0.00 / 0.00 / 0.00 (n=32) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.20 / 0.20 / 0.10 / 0.13 (n=40) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.22 / 0.22 / 0.20 / 0.21 |
| trigram | 0.89 / 0.89 / 0.83 / 0.84 (n=44) | 0.81 / 0.81 / 0.78 / 0.79 (n=32) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.82 / 0.82 / 0.41 / 0.52 (n=40) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.42 / 0.42 / 0.33 / 0.35 |
| keyword+trigram | 1.00 / 1.00 / 1.00 / 1.00 (n=44) | 0.81 / 0.81 / 0.77 / 0.78 (n=32) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.85 / 0.85 / 0.41 / 0.52 (n=40) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.00 / 0.00 / 0.00 / 0.00 (n=40) | 0.44 / 0.44 / 0.36 / 0.38 |
| mock vector | 1.00 / 1.00 / 0.99 / 0.99 (n=44) | 0.97 / 0.97 / 0.93 / 0.94 (n=32) | 0.10 / 0.17 / 0.06 / 0.09 (n=40) | 0.97 / 0.97 / 0.83 / 0.86 (n=40) | 0.07 / 0.15 / 0.04 / 0.06 (n=40) | 0.10 / 0.17 / 0.04 / 0.07 (n=40) | 0.53 / 0.57 / 0.47 / 0.50 |
| hybrid (mock) | 1.00 / 1.00 / 1.00 / 1.00 (n=44) | 1.00 / 1.00 / 0.97 / 0.98 (n=32) | 0.10 / 0.17 / 0.06 / 0.09 (n=40) | 1.00 / 1.00 / 0.51 / 0.64 (n=40) | 0.07 / 0.15 / 0.04 / 0.06 (n=40) | 0.07 / 0.17 / 0.04 / 0.07 (n=40) | 0.53 / 0.58 / 0.43 / 0.46 |
| bge-m3 vector | 1.00 / 1.00 / 0.99 / 0.99 (n=44) | 1.00 / 1.00 / 0.98 / 0.99 (n=32) | 0.80 / 0.88 / 0.57 / 0.64 (n=40) | 1.00 / 1.00 / 0.92 / 0.94 (n=40) | 0.38 / 0.60 / 0.15 / 0.26 (n=40) | 0.42 / 0.90 / 0.22 / 0.37 (n=40) | 0.76 / 0.89 / 0.63 / 0.69 |
| hybrid (bge-m3) | 1.00 / 1.00 / 1.00 / 1.00 (n=44) | 1.00 / 1.00 / 0.97 / 0.98 (n=32) | 0.78 / 0.88 / 0.50 / 0.59 (n=40) | 1.00 / 1.00 / 0.53 / 0.65 (n=40) | 0.38 / 0.60 / 0.15 / 0.26 (n=40) | 0.35 / 0.85 / 0.17 / 0.33 (n=40) | 0.75 / 0.89 / 0.55 / 0.63 |
| multilingual-e5-large vector | 1.00 / 1.00 / 0.92 / 0.94 (n=44) | 1.00 / 1.00 / 0.93 / 0.95 (n=32) | 0.68 / 0.78 / 0.38 / 0.47 (n=40) | 0.95 / 1.00 / 0.69 / 0.77 (n=40) | 0.20 / 0.50 / 0.11 / 0.20 (n=40) | 0.35 / 0.82 / 0.17 / 0.32 (n=40) | 0.69 / 0.85 / 0.53 / 0.60 |
| hybrid (multilingual-e5-large) | 1.00 / 1.00 / 1.00 / 1.00 (n=44) | 1.00 / 1.00 / 0.94 / 0.95 (n=32) | 0.65 / 0.78 / 0.34 / 0.44 (n=40) | 1.00 / 1.00 / 0.52 / 0.65 (n=40) | 0.20 / 0.50 / 0.11 / 0.20 (n=40) | 0.35 / 0.82 / 0.17 / 0.32 (n=40) | 0.69 / 0.85 / 0.51 / 0.59 |
| bge-m3 (cpu) vector | 1.00 / 1.00 / 0.99 / 0.99 (n=44) | 1.00 / 1.00 / 0.98 / 0.99 (n=32) | 0.80 / 0.88 / 0.57 / 0.64 (n=40) | 1.00 / 1.00 / 0.92 / 0.94 (n=40) | 0.38 / 0.60 / 0.15 / 0.26 (n=40) | 0.42 / 0.90 / 0.22 / 0.37 (n=40) | 0.76 / 0.89 / 0.63 / 0.69 |
| hybrid (bge-m3 (cpu)) | 1.00 / 1.00 / 1.00 / 1.00 (n=44) | 1.00 / 1.00 / 0.97 / 0.98 (n=32) | 0.78 / 0.88 / 0.50 / 0.59 (n=40) | 1.00 / 1.00 / 0.53 / 0.65 (n=40) | 0.38 / 0.60 / 0.15 / 0.26 (n=40) | 0.35 / 0.85 / 0.17 / 0.33 (n=40) | 0.75 / 0.89 / 0.55 / 0.63 |
| multilingual-e5-large (cpu) vector | 1.00 / 1.00 / 0.92 / 0.94 (n=44) | 1.00 / 1.00 / 0.93 / 0.95 (n=32) | 0.68 / 0.78 / 0.38 / 0.47 (n=40) | 0.95 / 1.00 / 0.69 / 0.77 (n=40) | 0.20 / 0.50 / 0.11 / 0.20 (n=40) | 0.35 / 0.82 / 0.17 / 0.32 (n=40) | 0.69 / 0.85 / 0.53 / 0.60 |
| hybrid (multilingual-e5-large (cpu)) | 1.00 / 1.00 / 1.00 / 1.00 (n=44) | 1.00 / 1.00 / 0.94 / 0.95 (n=32) | 0.65 / 0.78 / 0.34 / 0.44 (n=40) | 1.00 / 1.00 / 0.52 / 0.65 (n=40) | 0.20 / 0.50 / 0.11 / 0.20 (n=40) | 0.35 / 0.82 / 0.17 / 0.32 (n=40) | 0.69 / 0.85 / 0.51 / 0.59 |

## By language: Recall@5 over that language's queries

| Method | en | hi | bn | mr | te | ta | gu | ur | kn | or | ml |
|---|---|---|---|---|---|---|---|---|---|---|---|
| keyword | 1.00 | 0.40 | 0.17 | 0.17 | 0.17 | 0.17 | 0.17 | 0.40 | 0.17 | 0.17 | 0.17 |
| trigram | 1.00 | 0.30 | 0.25 | 0.38 | 0.50 | 0.38 | 0.33 | 0.40 | 0.50 | 0.50 | 0.50 |
| keyword+trigram | 1.00 | 0.40 | 0.33 | 0.42 | 0.50 | 0.42 | 0.33 | 0.40 | 0.50 | 0.50 | 0.50 |
| mock vector | 1.00 | 0.40 | 0.83 | 0.50 | 0.50 | 0.50 | 0.46 | 0.45 | 0.50 | 0.50 | 0.54 |
| hybrid (mock) | 1.00 | 0.40 | 0.79 | 0.50 | 0.50 | 0.50 | 0.54 | 0.45 | 0.50 | 0.50 | 0.54 |
| bge-m3 vector | 1.00 | 0.65 | 0.67 | 0.83 | 0.75 | 0.71 | 0.79 | 0.70 | 0.83 | 0.79 | 0.83 |
| hybrid (bge-m3) | 1.00 | 0.65 | 0.67 | 0.79 | 0.75 | 0.67 | 0.79 | 0.65 | 0.79 | 0.79 | 0.83 |
| multilingual-e5-large vector | 1.00 | 0.95 | 0.79 | 0.79 | 0.54 | 0.63 | 0.71 | 0.55 | 0.63 | 0.63 | 0.67 |
| hybrid (multilingual-e5-large) | 1.00 | 0.95 | 0.79 | 0.79 | 0.58 | 0.67 | 0.71 | 0.50 | 0.63 | 0.63 | 0.67 |
| bge-m3 (cpu) vector | 1.00 | 0.65 | 0.67 | 0.83 | 0.75 | 0.71 | 0.79 | 0.70 | 0.83 | 0.79 | 0.83 |
| hybrid (bge-m3 (cpu)) | 1.00 | 0.65 | 0.67 | 0.79 | 0.75 | 0.67 | 0.79 | 0.65 | 0.79 | 0.79 | 0.83 |
| multilingual-e5-large (cpu) vector | 1.00 | 0.95 | 0.79 | 0.79 | 0.54 | 0.63 | 0.71 | 0.55 | 0.63 | 0.63 | 0.67 |
| hybrid (multilingual-e5-large (cpu)) | 1.00 | 0.95 | 0.79 | 0.79 | 0.58 | 0.67 | 0.71 | 0.50 | 0.63 | 0.63 | 0.67 |

## Query latency on this corpus (ms)

| Method | p50 | p95 |
|---|---|---|
| keyword | 0.37 | 0.46 |
| trigram | 0.71 | 1.27 |
| keyword+trigram | 1.09 | 1.66 |
| mock vector | 0.08 | 0.15 |
| hybrid (mock) | 1.18 | 1.78 |
| bge-m3 vector | 0.05 | 0.05 |
| hybrid (bge-m3) | 1.16 | 1.78 |
| multilingual-e5-large vector | 0.05 | 0.05 |
| hybrid (multilingual-e5-large) | 1.12 | 1.68 |
| bge-m3 (cpu) vector | 0.04 | 0.05 |
| hybrid (bge-m3 (cpu)) | 1.12 | 1.79 |
| multilingual-e5-large (cpu) vector | 0.04 | 0.05 |
| hybrid (multilingual-e5-large (cpu)) | 1.13 | 1.85 |


## Against the bar ADR 0005 set

| Bar (set before measuring) | Offline (keyword + trigram + mock) | BGE-M3 | multilingual-e5-large |
|---|---|---|---|
| Same-script and inflected Recall@8 ≥ 0.85 in each language | Same-script 1.00; inflected 0.81 (keyword+trigram) | 1.00 and 1.00 (Recall@5) | 1.00 and 1.00 (Recall@5) |
| Cross-script Recall@8 ≥ 0.70, averaged over the Indic languages | 0.07–0.15 | **0.38 @5, 0.60 @10: below the bar** | 0.20 @5, 0.50 @10: below the bar |
| p95 query embedding from Mumbai, keeping retrieval < 150 ms | Under 1 ms | **Not measured in Mumbai.** On this laptop's CPU, p95 94 ms; adding the measured retrieval p95 (59.6 ms) gives about 154 ms | On CPU, p95 98 ms; about 158 ms |
| A data-processing position rule 5 accepts | In-process | Self-hosted in India: yes | Self-hosted in India: yes |

Resources on this machine:

| Model | Parameters | Weights in memory | Peak RSS (CPU) | Load |
|---|---|---|---|---|
| BGE-M3 | 568 M | 2,271 MB | 1,978 MB | 2 s from the local cache (113 s on first download) |
| multilingual-e5-large | 560 M | 2,240 MB | 1,677 MB | 2 s from the local cache |

Both are about nine times Vercel's 250 MB function limit, so either needs a separate service (the exception plan §13 decision 2 leaves to you).

## What this shows

1. **Without a multilingual model, transliterated and cross-script questions fail.** Keyword and trigram score 0.00 on both. The mock scores 0.10–0.17, which is chance. This is the gap a model would close.
2. **BGE-M3 is ahead on this set:** transliterated 0.80 against 0.68, cross-script 0.38 against 0.20 (Recall@5). Fusing it with keyword and trigram does not raise recall here, and lowers MRR on mixed-script queries.
3. **Neither model meets the cross-script bar.** Part of that is the cap described above; the rest is real. "diabetes" does not reliably find "நீரிழிவு". Canonical medicine names as extra index terms (architecture §10.2, Phase 3) would close the medicine part without a model.
4. **Latency is close to the budget.** On CPU, query embedding alone takes about 94 ms at p95. In-process with today's retrieval that is about 154 ms against a 150 ms budget. It must be measured on the actual Mumbai hardware before any decision.
5. **The set is small and unreviewed.** These numbers rank options; they are not a quality claim.

## Next

- A larger set, reviewed by native speakers, before the decision.
- Voyage on the same set when a key exists.
- Latency on a Mumbai machine of the size that would be paid for.
- Canonical medicine names as index terms (Phase 3), then this benchmark again.

## Phase 3: steps 3.9 and 3.10 (2026-11-23)

The Phase 1 set above is now the **held-out test split**: it was never tuned on. A **development split** (`eval/rag/indic/devDataset.ts`: cough, jaundice, vomiting, headache, each with a medicine, in the eleven languages) is the only data the two settings (the trigram threshold, 0.4; the lexicon expansion's weight, 0.5) were chosen on. BGE-M3 was re-run on this machine from the local model cache (no network), on both splits.

Recall@5 (cross-script also @10), production's keyword channel (`src/lib/rag/search.ts`, `keywordSql`):

| Held-out test split | Same script | Inflected | Transliterated | Mixed script | Cross-script @5 / @10 | Medicine in Latin |
|---|---|---|---|---|---|---|
| Phase 1: keyword + trigram | 1.00 | 0.81 | 0.00 | 0.85 | 0.00 / 0.00 | 0.00 |
| 3.5 keyword (exact, English stems, abbreviations, trigram) | 1.00 | 0.97 | 0.00 | 0.97 | 0.00 / 0.00 | 0.00 |
| 3.5 + **3.9** (romanised shadow text, transliteration) | 1.00 | 0.97 | **0.80** | 0.97 | 0.07 / 0.07 | 0.38 |
| 3.5 + **3.10** (concept lexicon) | 1.00 | 0.97 | 0.00 | 0.97 | 0.20 / 0.20 | 0.40 |
| 3.5 + **3.9 + 3.10** (production) | 1.00 | 0.97 | **0.80** | 0.88 | 0.25 / 0.28 | 0.40 |
| BGE-M3 vector (re-run) | 1.00 | 1.00 | 0.80 | 1.00 | 0.38 / 0.60 | 0.42 |

| Development split | Same script | Inflected | Transliterated | Mixed script | Cross-script @5 / @10 | Medicine in Latin |
|---|---|---|---|---|---|---|
| Phase 1: keyword + trigram | 1.00 | 1.00 | 0.00 | — | 0.00 / 0.00 | 0.00 |
| 3.5 + 3.9 + 3.10 (production) | 1.00 | 1.00 | 0.90 | 1.00 | 0.40 / 0.90 | 0.42 |

**Read with care:**

1. **A change made after seeing the test split.** The first combined version also matched the lexicon's names as romanised skeletons and by trigram. On the test split that lowered two Phase 1 numbers (inflected 0.72, mixed-script 0.68, against 0.81 and 0.85), because a concept's names in related languages romanise alike (madhumeh, madhumeha, madhumeham), so other languages' lines matched as strongly as the question's own. The development topics' words differ more between languages, so the development split didn't show it. The expansion now matches exact names only; the numbers above are after that change, and its cross-script figure fell from 0.40 to 0.25 (@5).
2. **Cross-script is capped near 0.4 at @5 by design of the set:** an English "diabetes" names the same condition in ten Indic lines, and only one counts as relevant; @10 is the fairer reading on the development split (0.90).
3. **The lexicon was written by the team that wrote this set.** The four test conditions are among the commonest and are in the lexicon, written from general usage, not copied from the set; the test numbers for 3.10 are therefore an upper bound for unseen conditions.
4. **The embedding decision (ADR 0005 part A) still stands open.** Without a model, keyword search now equals BGE-M3 on transliterated words and beats it on mixed script at @5 here; it still trails BGE-M3 on cross-script (0.25 against 0.38 @5, 0.28 against 0.60 @10).

## The sealed held-out split (RAG Phase 4, sealed 2026-11-23)

Plan §13.5 E. 71 new questions over the evaluation fixture (`rag-eval-v2`), in the plan's groups (readers, historical, medicines, allergy, critical, several documents, imported, no record, insufficient, operational, nurse, SOP, stale) and the language cases (record questions in six Indic languages; knowledge questions same-script, inflected, transliterated and cross-script). Written before any Phase 4 change was measured; no question repeats one of the 230.

- File: `eval/rag/sealed/phase4.json`
- sealed split sha-256: `c071b2e8f41e8b2ff1ae29b3b740b09cc7dd4f3cb211510a339b91a3df4ad4f9`
- Run: `npm run eval:rag:sealed -- --phase <n>` (this split is the default, `--split phase4`), once per phase, at the end. Runs so far: `eval/rag/sealed/runs.json`.

### Phase 4 run (2026-11-24, commit 1a69b59, the only run for phase 4)

| | Old held-out test split (113) | Sealed split (71) |
|---|---|---|
| Recall@8 | 0.96 | **0.831** |
| MRR | 0.90 | **0.795** |
| Correct with valid citations | 205/230 on the whole set (89.1%) | **52/71 (73.2%)** |

Reported, not tuned on. Where it falls short (for the next phase to work on, with new held-out questions): medicine questions by class or form ("a statin", "the antibiotic", "the inhaler", "an asthma reliever": 2 of 6 — the lexicon names medicines, not classes); imaging, referral and pending-scan questions in new words (routed as narrative, "no record"); "panic values" for critical values; two knowledge questions and four cross-script or transliterated ones ("no record"); three questions answered that should have been "no record" (HIV status, ECG, oxygen cylinder stock). The sealed questions' expected answers are as unreviewed as the rest of the set (pending clinical sign-off), so a few failures may be the expectation's, not the system's; none was changed after the run.

## The phase 5 sealed split (RAG Phase 5, sealed 2026-11-24)

Plan §13.5 E, a new file for a new phase. 94 new questions over the same fixture (`rag-eval-v2`), written and sealed on `rag/phase-5` before any Phase 5 change: every answer mode (chart Q&A, knowledge Q&A, visit brief, nurse handoff, explain report, health timeline, pre-visit questions), all eleven languages (record questions, knowledge questions same-script, inflected, transliterated and cross-script, and patient-mode answers requested in each language), 20 questions whose right answer is "no record", and new phrasings of each Phase 4 gap (medicine classes and forms, including classes she is **not** on; imaging, referral and pending-scan wording; "alarm", "phoned through" and "panic" for critical values). No question repeats one of the 230, or one of `phase4.json` (`scripts/lib/sealedSplit.test.ts`). Expected answers are the team's, pending clinical sign-off.

- File: `eval/rag/sealed/phase5.json`
- sealed split sha-256: `b063fd2bd3b47cc5a6728abc6a62170a37b2bd8ec190040a409715d576653091`
- Run: `npm run eval:rag:sealed -- --phase <n> --split phase5`, once per phase, at the end. Every sealed report now also counts **confidently wrong** answers (answered where "no record" or a refusal was right, or a forbidden value stated) on their own: a false answer counts as worse than a refusal.

