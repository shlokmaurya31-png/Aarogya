/**
 * Shared by the HTTP gates (tenancy sweep, one-patient): build the app, start
 * `next start` on a free port against the caller's DATABASE_URL, and log in.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const NEXT = path.join(ROOT, "node_modules", ".bin", "next");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Builds (unless --no-build and a build exists) and starts the app. `env` is
 * added to the server's environment (e.g. SMS_PROVIDER=outbox).
 */
export async function startServer(env: Record<string, string> = {}): Promise<{ base: string; child: ChildProcess }> {
  if (!process.argv.includes("--no-build") || !existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.log("Building the app (next build)…");
    const b = spawnSync(NEXT, ["build"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    if (b.status !== 0) throw new Error(`next build failed:\n${(b.stdout + b.stderr).slice(-3000)}`);
  }
  const port = await freePort();
  const child = spawn(NEXT, ["start", "-p", String(port)], { cwd: ROOT, env: { ...process.env, ...env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${log.slice(-2000)}`);
    try {
      await fetch(base + "/api/hospital/patients");
      return { base, child };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill("SIGTERM");
  throw new Error(`next start did not become ready:\n${log.slice(-2000)}`);
}

let loginCount = 0;
/** Logs in and returns the session cookie. A distinct client address per login keeps the per-IP limit out of the way. */
export async function loginAs(base: string, email: string, password: string): Promise<string> {
  loginCount++;
  const res = await fetch(base + "/api/scholar-auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${Math.floor(loginCount / 250)}.${loginCount % 250}` },
    body: JSON.stringify({ email, password }),
  });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (res.status !== 200 || cookies.length === 0) throw new Error(`login as ${email} failed: HTTP ${res.status} ${await res.text()}`);
  return cookies.join("; ");
}
