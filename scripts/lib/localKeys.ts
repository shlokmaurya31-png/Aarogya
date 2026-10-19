import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reads named settings for the manual real-provider runs: the process
 * environment first, then .env.local, then .env. Values are returned, never
 * printed, logged or copied into process.env (so a child process or a
 * provider SDK picking up the environment never sees them by accident).
 */
export function readLocalKeys<K extends string>(names: readonly K[], root = path.resolve(__dirname, "..", "..")): Partial<Record<K, string>> {
  const files = [".env.local", ".env"].map((f) => path.join(root, f)).filter((f) => existsSync(f));
  const fromFiles: Record<string, string> = {};
  for (const file of files.reverse()) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      fromFiles[m[1]] = v;
    }
  }
  const out: Partial<Record<K, string>> = {};
  for (const n of names) {
    const v = process.env[n] ?? fromFiles[n];
    if (v !== undefined && v.trim() !== "") out[n] = v.trim();
  }
  return out;
}
