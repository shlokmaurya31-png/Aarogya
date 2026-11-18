"""
RAG Phase 1, step 1.9 — the optional local-model run of the Indic benchmark.

Embeds the benchmark's synthetic corpus and queries (written by
`npm run eval:rag:indic -- --dump corpus.json`) with a self-hosted
multilingual model, ON THIS MACHINE, and writes a vectors file the
benchmark reads (`npm run eval:rag:indic -- --vectors out.json`).

Nothing is sent to any service: the model weights are downloaded once from
the Hugging Face hub and run locally. Synthetic data only.

    python scripts/indic-embed.py corpus.json out.json BAAI/bge-m3
    python scripts/indic-embed.py corpus.json out.json intfloat/multilingual-e5-large
    INDIC_DEVICE=cpu python scripts/indic-embed.py …   (latency on a CPU-only machine)

multilingual-e5 expects "query: " / "passage: " prefixes; BGE-M3 needs none.
Needs: sentence-transformers, torch, psutil (a throwaway virtualenv is fine).
"""
import json
import os
import resource
import sys
import time

import psutil
import torch
from sentence_transformers import SentenceTransformer


def main() -> None:
    src, out, model_id = sys.argv[1], sys.argv[2], sys.argv[3]
    data = json.load(open(src, encoding="utf-8"))
    e5 = "e5" in model_id.lower()
    # INDIC_DEVICE=cpu measures what a CPU-only server would see.
    device = os.environ.get("INDIC_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
    proc = psutil.Process(os.getpid())

    t0 = time.perf_counter()
    model = SentenceTransformer(model_id, device=device)
    load_s = time.perf_counter() - t0

    docs = [("passage: " if e5 else "") + d["text"] for d in data["docs"]]
    t0 = time.perf_counter()
    dv = model.encode(docs, batch_size=16, normalize_embeddings=True, convert_to_numpy=True)
    docs_s = time.perf_counter() - t0

    # Queries one at a time, as a request would: per-query latency.
    qv, times = [], []
    model.encode([("query: " if e5 else "") + "warm up"], normalize_embeddings=True)
    for q in data["queries"]:
        t0 = time.perf_counter()
        qv.append(model.encode([("query: " if e5 else "") + q["text"]], normalize_embeddings=True, convert_to_numpy=True)[0])
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    pick = lambda p: round(times[min(len(times) - 1, max(0, int(round(p / 100 * len(times))) - 1))], 1)

    weights_mb = sum(p.numel() * p.element_size() for p in model.parameters()) / 1e6
    peak_rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1e6 if sys.platform == "darwin" else 1e3)
    json.dump({
        "model": model_id.split("/")[-1] + ("" if device == "mps" else f" ({device})"),
        "dims": int(dv.shape[1]),
        "docs": {d["id"]: v.tolist() for d, v in zip(data["docs"], dv)},
        "queries": {q["id"]: v.tolist() for q, v in zip(data["queries"], qv)},
        "queryLatencyMs": {"p50": pick(50), "p95": pick(95)},
        "resources": {
            "device": device,
            "parameters (M)": round(sum(p.numel() for p in model.parameters()) / 1e6),
            "weights in memory (MB)": round(weights_mb),
            "peak RSS (MB)": round(peak_rss_mb),
            "current RSS (MB)": round(proc.memory_info().rss / 1e6),
            "load (s)": round(load_s, 1),
            f"embed {len(docs)} passages (s)": round(docs_s, 2),
        },
    }, open(out, "w"))
    print(f"{model_id}: {len(docs)} passages, {len(qv)} queries; query p50 {pick(50)} ms, p95 {pick(95)} ms; peak RSS {round(peak_rss_mb)} MB on {device}")


if __name__ == "__main__":
    main()
