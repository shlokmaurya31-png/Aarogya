/**
 * Workflow spine §6 — static analysis behind the "a state change must emit"
 * CI rule (emitCoverage.test.ts). Pure TypeScript-compiler analysis; no
 * database.
 *
 * A service function "writes" if its body (including nested callbacks) calls a
 * Prisma write method on a delegate (`prisma.x.create(…)`, `tx.x.update(…)`,
 * …) or a raw INSERT/UPDATE/DELETE, or reaches such a write through private
 * (non-exported) helpers in the same file, at any depth. It "emits" if it, or
 * a private helper it reaches in the same file, calls emitDomainEvent; or it
 * calls (one level deep) a function anywhere in src/lib that does; or it
 * reaches a registered emitting helper (EMITTING_HELPERS) through any chain of
 * calls inside src/lib.
 *
 * Event types: the string literals inside an emitDomainEvent / emitFacilityEvent
 * call (`type: "X"`, or a literal passed to a builder), plus the registered
 * types of the helpers a function reaches.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const CLIENTS = new Set(["prisma", "tx", "db", "client", "trx"]);

export interface FunctionFacts {
  /** "src/lib/…/file.ts#functionName" */
  key: string;
  file: string;
  name: string;
  line: number;
  writes: string[];
  emits: boolean;
  /** PascalCase string literals inside emit calls: the event types it emits directly. */
  emitTypes: string[];
  callees: string[];
  /** Plain-identifier calls only (`foo(…)`, not `x.foo(…)`): the edges followed to registered helpers. */
  calls: string[];
  /** emitDomainEvent called with the global client while the function also writes. */
  emitsOutsideTx: boolean;
}

function walk(dir: string, pred: (f: string) => boolean): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p, pred) : pred(p) ? [p] : [];
  });
}

function rawWrite(node: ts.Node, src: ts.SourceFile): string | null {
  if (!ts.isTaggedTemplateExpression(node) && !ts.isCallExpression(node)) return null;
  const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !/^\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)$/.test(callee.name.text)) return null;
  const text = node.getText(src);
  const m = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(\w+)"/i.exec(text);
  return m ? `raw ${m[1].split(/\s+/)[0].toUpperCase()} ${m[2]}` : null;
}

/** Facts for every exported function (declarations and exported const arrows) in the given files. */
export function analyze(files: string[], root: string): FunctionFacts[] {
  const out: FunctionFacts[] = [];
  for (const file of files) {
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const rel = path.relative(root, file);
    const fns: { name: string; node: ts.Node; exported: boolean }[] = [];
    const isExported = (n: ts.Node) => !!(ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export);
    for (const st of src.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.push({ name: st.name.text, node: st.body, exported: isExported(st) });
      if (ts.isVariableStatement(st)) {
        const exp = isExported(st);
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            fns.push({ name: d.name.text, node: d.initializer, exported: exp });
          }
        }
      }
    }
    const fileFacts: FunctionFacts[] = [];
    const privateNames = new Set(fns.filter((f) => !f.exported).map((f) => f.name));
    for (const fn of fns) {
      const writes = new Set<string>();
      const callees = new Set<string>();
      const calls = new Set<string>();
      const emitTypes = new Set<string>();
      let emits = false;
      let emitsGlobal = false;
      const visit = (n: ts.Node) => {
        const raw = rawWrite(n, src);
        if (raw) writes.add(raw);
        if (ts.isCallExpression(n)) {
          const e = n.expression;
          if (ts.isPropertyAccessExpression(e) && WRITE_METHODS.has(e.name.text) && ts.isPropertyAccessExpression(e.expression)
            && ts.isIdentifier(e.expression.expression) && CLIENTS.has(e.expression.expression.text)) {
            writes.add(`${e.expression.name.text}.${e.name.text}`);
          }
          const calleeName = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
          if (calleeName && EMIT_CALLS.has(calleeName)) {
            const lits = (a: ts.Node): void => {
              if (ts.isStringLiteral(a) && /^[A-Z][A-Za-z0-9]+$/.test(a.text)) emitTypes.add(a.text);
              ts.forEachChild(a, lits);
            };
            n.arguments.forEach(lits);
          }
          if (calleeName === "emitDomainEvent") {
            emits = true;
            const first = n.arguments[0];
            if (first && ts.isIdentifier(first) && first.text === "prisma") emitsGlobal = true;
          } else if (calleeName) {
            callees.add(calleeName);
            if (ts.isIdentifier(e)) calls.add(calleeName);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(fn.node);
      fileFacts.push({
        key: `${rel}#${fn.name}`, file: rel, name: fn.name, line: src.getLineAndCharacterOfPosition(fn.node.getStart()).line + 1,
        writes: [...writes].sort(), emits, emitTypes: [...emitTypes].sort(), callees: [...callees], calls: [...calls],
        emitsOutsideTx: emitsGlobal && writes.size > 0,
      });
    }
    // Fold in what private same-file helpers do, at any depth: a write (or an
    // emit) made through a non-exported helper is the caller's.
    const byName = new Map(fileFacts.map((f) => [f.name, f]));
    for (const f of fileFacts) {
      const seen = new Set<string>([f.name]);
      const queue = f.calls.filter((c) => privateNames.has(c));
      const writes = new Set(f.writes);
      const types = new Set(f.emitTypes);
      let emits = f.emits;
      while (queue.length) {
        const name = queue.shift()!;
        if (seen.has(name)) continue;
        seen.add(name);
        const h = byName.get(name);
        if (!h) continue;
        h.writes.forEach((w) => writes.add(`${w} (via ${name})`));
        h.emitTypes.forEach((t) => types.add(t));
        emits ||= h.emits;
        queue.push(...h.calls.filter((c) => privateNames.has(c)));
      }
      out.push({ ...f, writes: [...writes].sort(), emitTypes: [...types].sort(), emits });
    }
  }
  return out;
}

const EMIT_CALLS = new Set(["emitDomainEvent", "emitFacilityEvent"]);

/**
 * The event types each function emits: its own literals, those of functions it
 * calls directly (one level), and the registered types of every registered
 * helper it reaches through plain calls at any depth.
 */
export function resolveEmitTypes(facts: FunctionFacts[], helpers: Record<string, string[]> = {}): Map<string, Set<string>> {
  const byName = new Map<string, FunctionFacts[]>();
  for (const f of facts) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const out = new Map<string, Set<string>>();
  for (const f of facts) {
    const types = new Set(f.emitTypes);
    for (const c of f.callees) for (const g of byName.get(c) ?? []) g.emitTypes.forEach((t) => types.add(t));
    const seen = new Set<string>([f.key]);
    const queue = [f];
    while (queue.length) {
      const cur = queue.shift()!;
      helpers[cur.key]?.forEach((t) => types.add(t));
      for (const c of cur.calls) for (const g of byName.get(c) ?? []) if (!seen.has(g.key)) { seen.add(g.key); queue.push(g); }
    }
    out.set(f.key, types);
  }
  return out;
}

/** Resolve "emits": directly, one level deep, or through a registered helper at any depth. */
export function resolveEmits(facts: FunctionFacts[], helpers: Record<string, string[]> = {}): Map<string, boolean> {
  const direct = new Set(facts.filter((f) => f.emits).map((f) => f.name));
  const types = resolveEmitTypes(facts, helpers);
  return new Map(facts.map((f) => [f.key, f.emits || f.callees.some((c) => direct.has(c)) || (types.get(f.key)?.size ?? 0) > 0]));
}

export function libFiles(repoRoot: string): string[] {
  return walk(path.join(repoRoot, "src", "lib"), (f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
}

export function routeFiles(repoRoot: string): string[] {
  return walk(path.join(repoRoot, "src", "app"), (f) => /route\.ts$/.test(f));
}

/** Exported service functions in src/lib that write without emitting (before exemptions). */
export function unemittingWriters(repoRoot: string, helpers: Record<string, string[]> = {}): FunctionFacts[] {
  const all = analyze(libFiles(repoRoot), repoRoot);
  const emits = resolveEmits(all, helpers);
  const exported = new Set(analyzeExportedKeys(libFiles(repoRoot), repoRoot));
  return all.filter((f) => exported.has(f.key) && f.writes.length > 0 && !emits.get(f.key));
}

/** Route handlers (GET/POST/…) that write domain tables directly. */
export function writingRoutes(repoRoot: string): FunctionFacts[] {
  return analyze(routeFiles(repoRoot), repoRoot).filter((f) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(f.name) && f.writes.length > 0);
}

function analyzeExportedKeys(files: string[], root: string): string[] {
  const keys: string[] = [];
  for (const file of files) {
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const rel = path.relative(root, file);
    for (const st of src.statements) {
      const exp = !!(ts.getCombinedModifierFlags(st as unknown as ts.Declaration) & ts.ModifierFlags.Export);
      if (!exp) continue;
      if (ts.isFunctionDeclaration(st) && st.name) keys.push(`${rel}#${st.name.text}`);
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) keys.push(`${rel}#${d.name.text}`);
    }
  }
  return keys;
}
