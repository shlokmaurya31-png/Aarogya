import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RAG Phase 1, step 1.1 — no route reaches an AI provider without passing the
 * checks (docs/RAG_IMPLEMENTATION_PLAN.md §3.1).
 *
 * Walks the import graph from every route under src/app and finds each one
 * that can reach a provider factory. Every such path must pass through a
 * GATEWAY, the only modules allowed to import a factory, and each gateway
 * must contain its checks. A new route or module that reaches a provider
 * fails here until it is reviewed and listed.
 */
const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "src");

/** The provider factories (and the SDK). Importing one is reaching a provider. */
const FACTORIES = ["src/lib/ai/getAIProvider.ts", "src/lib/ai/record/index.ts", "src/lib/ai/embeddings/index.ts", "src/lib/ai/documents/index.ts", "src/lib/ai/anthropicProvider.ts"];

/** The only modules (outside src/lib/ai itself) allowed to import a factory, and the checks each must make. */
const GATEWAYS: Record<string, { why: string; mustContain: string[] }> = {
  "src/lib/rag/ask.ts": { why: "the record gateway (/api/ai/ask, and /api/chat's record questions)", mustContain: ["resolveAiAccess(", "checkLimits(", "logInteraction(", "subjectIdentifiers(", "checkSentence("] },
  "src/lib/rag/assistant.ts": { why: "the portal assistant's gateway (/api/chat)", mustContain: ["mayUseAiOver(", "realDataEnabled(", "checkLimits(", "patientSafety(", "personIdentifiers(", "issueAssistantPermit(", "logAssistantInteraction("] },
  // RAG Phase 3, step 3.4: knowledge Q&A, no patient; the organisation's own setting decides whether its knowledge text may reach an external provider.
  "src/lib/rag/knowledgeAsk.ts": { why: "the knowledge gateway (/api/ai/knowledge/ask)", mustContain: ["roleHasPermission(", "checkLimits(", "knowledgeClassesFor(", "knowledgePermit(", "ai.knowledge.external_providers", "logInteraction(", "checkSentence("] },
  "src/lib/rag/retrieve.ts": { why: "retrieval, reached only from ask.ts with a permit from resolveAiAccess", mustContain: ["access.permit"] },
  "src/lib/rag/embed.ts": { why: "the index writer (the rag-indexer and the re-embed job), with a permit", mustContain: ["permit: AiPermit"] },
  "src/lib/rag/reembed.ts": { why: "the re-embed job, with a permit per owner", mustContain: ["aiAssistancePermit("] },
  "src/lib/documents/pipeline.ts": { why: "the 4a document pipeline, with a processing permit", mustContain: ["documentProcessingPermit("] },
  "src/lib/ai/scholar.ts": { why: "Aarogya Scholar: synthetic cases only, typed without the portal assistant", mustContain: ["ScholarAI"] },
};

const BACKGROUND = ["src/lib/documents/pipeline.ts", "src/lib/rag/embed.ts", "src/lib/rag/reembed.ts"];
/** Event dispatch alone: the consumers, without the tick's re-embed batch. */
const DISPATCH = ["src/lib/documents/pipeline.ts", "src/lib/rag/embed.ts"];

/** Every route that can reach a provider, and the gateway it goes through. */
const EXPECTED_ROUTES: Record<string, string[]> = {
  "src/app/api/ai/ask/route.ts": ["src/lib/rag/ask.ts"],
  "src/app/api/ai/knowledge/ask/route.ts": ["src/lib/rag/knowledgeAsk.ts"],
  "src/app/api/chat/route.ts": ["src/lib/rag/assistant.ts", "src/lib/rag/ask.ts"],
  "src/app/api/student/viva/route.ts": ["src/lib/ai/scholar.ts"],
  // RAG Phase 5 (5.6), reviewed: OPS_QA calls no provider; the route reaches ask.ts only for its rate limits and AskError.
  "src/app/api/ai/ops/ask/route.ts": ["src/lib/rag/ask.ts"],
  // RAG Phase 5 (5.8), reviewed: opening a source calls no provider; it reaches ask.ts for AskError and embed.ts through
  // the knowledge search's scope re-read (hitsFor, no embedding is made).
  "src/app/api/ai/sources/[id]/route.ts": ["src/lib/rag/ask.ts", "src/lib/rag/embed.ts"],
  // Background work (the runner's tick and event dispatch): the 4a pipeline and the rag-indexer, each with its permit.
  "src/app/api/cron/tick/route.ts": BACKGROUND,
  "src/app/api/hospital/enterprise/events/dispatch/route.ts": DISPATCH,
  "src/app/api/hospital/enterprise/workflow-ops/tick/route.ts": DISPATCH,
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const graph = new Map<string, string[]>();
function importsOf(file: string): string[] {
  if (!graph.has(file)) {
    const src = readFileSync(file, "utf8");
    // Static imports and re-exports, dynamic imports; type-only imports reach nothing at run time.
    const specs = [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm), ...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    const sdk = /from\s+["']@anthropic-ai\/sdk["']/.test(src) ? ["@anthropic-ai/sdk"] : [];
    graph.set(file, [...specs.map((s) => resolveImport(file, s)).filter((x): x is string => !!x), ...sdk]);
  }
  return graph.get(file)!;
}

/** The gateways on the way from `start` to any factory, or "UNGATED" if a factory is reachable without one. */
function gatewaysOnPaths(start: string): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const r = f === "@anthropic-ai/sdk" ? f : rel(f);
    if (GATEWAYS[r]) { found.add(r); return; }
    if (FACTORIES.includes(r) || r === "@anthropic-ai/sdk") { found.add("UNGATED"); return; }
    if (f === "@anthropic-ai/sdk") return;
    for (const n of importsOf(f)) walk(n);
  };
  for (const n of importsOf(start)) walk(n);
  return found;
}

const routes = files(path.join(SRC, "app")).filter((f) => /\/route\.ts$/.test(f));

describe("AI routes reach a provider only through a gateway", () => {
  it("finds the routes", () => expect(routes.length).toBeGreaterThan(100));

  it.each(routes.map(rel))("%s", (route) => {
    const g = gatewaysOnPaths(path.join(ROOT, route));
    expect(g.has("UNGATED"), `${route} reaches a provider factory without a gateway`).toBe(false);
    if (g.size) expect([...g].sort(), `${route} reaches a provider: list it in EXPECTED_ROUTES after review`).toEqual([...(EXPECTED_ROUTES[route] ?? [])].sort());
  });

  it("every expected route is still there and still gated", () => {
    for (const [route, gws] of Object.entries(EXPECTED_ROUTES)) expect([...gatewaysOnPaths(path.join(ROOT, route))].sort(), route).toEqual([...gws].sort());
  });
});

describe("only gateways import a provider factory", () => {
  it.each(files(SRC).map(rel).filter((f) => !f.startsWith("src/lib/ai/")))("%s", (file) => {
    const direct = importsOf(path.join(ROOT, file)).map((f) => (f === "@anthropic-ai/sdk" ? f : rel(f))).filter((f) => FACTORIES.includes(f) || f === "@anthropic-ai/sdk");
    if (direct.length) expect(GATEWAYS[file], `${file} imports ${direct.join(", ")} but is not a gateway`).toBeDefined();
  });

  it.each(Object.entries(GATEWAYS))("%s makes its checks", (file, spec) => {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    for (const needle of spec.mustContain) expect(src, `${file} (${spec.why}) must contain ${needle}`).toContain(needle);
  });
});

describe("every real provider checks its permit and its data-policy flag", () => {
  it.each([
    ["src/lib/ai/anthropicProvider.ts", ["assertAssistantPermit(", 'providerMayReceive("ANTHROPIC"']],
    ["src/lib/ai/record/claude.ts", ["assertAiPermit(", 'providerMayReceive("ANTHROPIC"']],
    ["src/lib/ai/documents/claude.ts", ["assertPermit(", 'providerMayReceive("ANTHROPIC"']],
    ["src/lib/ai/embeddings/voyage.ts", ["assertAiPermit(", 'providerMayReceive("VOYAGE"']],
  ] as const)("%s", (file, needles) => {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    for (const n of needles) expect(src).toContain(n);
  });
});
