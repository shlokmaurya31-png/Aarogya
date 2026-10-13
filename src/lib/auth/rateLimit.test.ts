import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, clearRateLimit, clientIp, resetInboundRateLimiter } from "./rateLimit";

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
