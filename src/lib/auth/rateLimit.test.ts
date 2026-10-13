import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, clearRateLimit, clientIp, rateLimit, resetInboundRateLimiter } from "./rateLimit";

describe("checkRateLimit", () => {
  beforeEach(() => resetInboundRateLimiter());

  it("allows up to the limit then refuses within the window", () => {
    expect(checkRateLimit("k", 2, 1000, 0).allowed).toBe(true);
    expect(checkRateLimit("k", 2, 1000, 10).allowed).toBe(true);
    const refused = checkRateLimit("k", 2, 1000, 20);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(980);
  });

  it("slides: access returns once the oldest hit leaves the window", () => {
    checkRateLimit("k", 1, 1000, 0);
    expect(checkRateLimit("k", 1, 1000, 999).allowed).toBe(false);
    expect(checkRateLimit("k", 1, 1000, 1000).allowed).toBe(true);
  });

  it("keys are independent and can be cleared", () => {
    checkRateLimit("a", 1, 1000, 0);
    expect(checkRateLimit("b", 1, 1000, 0).allowed).toBe(true);
    clearRateLimit("a");
    expect(checkRateLimit("a", 1, 1000, 1).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded hop, then x-real-ip, then unknown", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers({ "x-real-ip": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("rateLimit (Upstash backend)", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
    resetInboundRateLimiter();
  });

  it("uses the in-memory limiter when Upstash is not configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await rateLimit("m", 1, 1000)).allowed).toBe(true);
    expect((await rateLimit("m", 1, 1000)).allowed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends an atomic EVAL to Upstash and maps the reply", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io/";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: [0, 1234] })));
    vi.stubGlobal("fetch", fetchSpy);

    expect(await rateLimit("u", 5, 60_000)).toEqual({ allowed: false, retryAfterMs: 1234 });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://example.upstash.io");
    expect(init.headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(init.body);
    expect(body[0]).toBe("EVAL");
    expect(body.slice(2, 4)).toEqual([1, "aarogya:rl:u"]);
  });

  it("falls back to memory when Upstash errors", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await rateLimit("f", 1, 1000)).allowed).toBe(true);
    expect((await rateLimit("f", 1, 1000)).allowed).toBe(false);
  });
});
