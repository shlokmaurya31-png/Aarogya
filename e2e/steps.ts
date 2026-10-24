import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Runs one hospital-side step (scripts/lib/e2eHospitalSteps.ts) through the
 * real services, with the smoke run's environment, and returns its JSON.
 */
export function hospitalStep<T = Record<string, unknown>>(cmd: string, arg?: string): T {
  const args = ["scripts/lib/e2eHospitalSteps.ts", cmd, ...(arg ? [arg] : [])];
  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), args, { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`hospital step ${cmd} failed:\n${r.stdout}\n${r.stderr}`);
  const last = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!last) throw new Error(`hospital step ${cmd} printed nothing`);
  return JSON.parse(last) as T;
}
