import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixture, signIn } from "../e2e/fixture";
import { MOBILE_SCREENS } from "../e2e/mobileScreens";

/**
 * Flagship 5, step 6a — each of the six screens, cold (a fresh browser
 * context: no cache), on Lighthouse's mobile throttling applied through the
 * DevTools protocol: the CPU 4× slower (a Moto G-class phone), slow 4G
 * (562.5 ms round trip, 1.47 Mbit/s down, 675 kbit/s up). Measured in the page:
 *
 *   interactive   when every script has run (the load event), the screen's
 *                 heading is drawn and its data loaded, or the last long task
 *                 ends, whichever is later
 *   JS            the compressed bytes of every script the screen loaded
 *
 * Budgets: interactive within 3.5 s; JS within JS_BUDGET_KB. Writes
 * .perf-report/mobile.md and mobile.json.
 */
const INTERACTIVE_BUDGET_MS = 3_500;
export const JS_BUDGET_KB = Number(process.env.PERF_MOBILE_JS_BUDGET_KB ?? 200);
const RUNS = Number(process.env.PERF_MOBILE_RUNS ?? 3);

/** In the page from the first byte: long tasks, and the moment the screen is ready (heading drawn, nothing "Loading"). */
const PROBE = () => {
  const w = window as unknown as { __lt: number; __ready: number | null };
  w.__lt = 0; w.__ready = null;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lt = Math.max(w.__lt, e.startTime + e.duration); }).observe({ type: "longtask", buffered: true }); } catch { /* no long-task timing */ }
  const check = () => {
    const main = document.querySelector("main#main");
    const heading = main?.querySelector("h1, h2");
    const loading = main ? Array.from(main.querySelectorAll("*")).some((el) => el.childElementCount === 0 && /^Loading/.test(el.textContent?.trim() ?? "")) : true;
    // Ready only once every script has run (the load event: hydrated) and the screen's data is drawn.
    if (document.readyState === "complete" && heading && (heading as HTMLElement).offsetParent !== null && !loading) { w.__ready = performance.now(); return; }
    setTimeout(check, 25);
  };
  setTimeout(check, 0);
};

test("perf:mobile: six patient screens interactive within 3.5 s on a Moto G-class phone over slow 4G", async ({ browser }) => {
  const f = fixture();
  const login = await browser.newContext();
  const lp = await login.newPage();
  await signIn(lp, "/patient/login", f.patient.email, f.password);
  await lp.waitForURL((u) => u.pathname === "/patient");
  const state = await login.storageState();
  await login.close();

  const rows: { screen: string; path: string; interactiveMs: number[]; jsKb: number; medianMs: number; pass: boolean }[] = [];
  for (const s of MOBILE_SCREENS) {
    const times: number[] = [];
    let jsKb = 0;
    for (let run = 0; run < RUNS; run++) {
      const ctx = await browser.newContext({ storageState: state, viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      const page = await ctx.newPage();
      await page.addInitScript(PROBE);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto(s.path, { waitUntil: "commit" });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __ready: number | null }).__ready), { timeout: 60_000 }).not.toBeNull();
      // Let the main thread settle (a quiet half second), then read.
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const w = window as unknown as { __lt: number; __ready: number };
        const js = performance.getEntriesByType("resource").filter((r) => (r as PerformanceResourceTiming).initiatorType === "script" || /\.js(\?|$)/.test(r.name))
          .reduce((a, r) => a + (r as PerformanceResourceTiming).encodedBodySize, 0);
        return { interactive: Math.max(w.__ready, w.__lt), js };
      });
      times.push(Math.round(m.interactive));
      jsKb = Math.round(m.js / 1024);
      await ctx.close();
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    rows.push({ screen: s.name, path: s.path, interactiveMs: times, jsKb, medianMs: median, pass: median <= INTERACTIVE_BUDGET_MS && jsKb <= JS_BUDGET_KB });
  }

  const md = [
    "# perf:mobile",
    "",
    `Moto G-class CPU (4× slower), slow 4G (562.5 ms, 1.47 Mbit/s down, 675 kbit/s up), cold cache, median of ${RUNS}. Budgets: interactive ≤ ${INTERACTIVE_BUDGET_MS} ms, JS ≤ ${JS_BUDGET_KB} KB (compressed).`,
    "",
    "| Screen | Path | Interactive (median) | Runs | JS | Result |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.screen} | ${r.path} | ${r.medianMs} ms | ${r.interactiveMs.join(", ")} | ${r.jsKb} KB | ${r.pass ? "PASS" : "**FAIL**"} |`),
  ].join("\n");
  const out = path.join(process.cwd(), ".perf-report");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "mobile.md"), md + "\n");
  writeFileSync(path.join(out, "mobile.json"), JSON.stringify({ at: new Date().toISOString(), budgets: { interactiveMs: INTERACTIVE_BUDGET_MS, jsKb: JS_BUDGET_KB }, rows }, null, 2));
  console.log(md);
  expect(rows.filter((r) => !r.pass).map((r) => `${r.screen}: ${r.medianMs} ms, ${r.jsKb} KB`), "screens over budget").toEqual([]);
});
