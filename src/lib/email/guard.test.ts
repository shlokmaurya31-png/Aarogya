import { describe, it, expect } from "vitest";
import { assertEmailProviderAllowed, UnsafeEmailProviderError } from "./guard";

describe("EMAIL_PROVIDER=outbox is refused where real mail is at stake", () => {
  it("is allowed in development and tests", () => {
    expect(() => assertEmailProviderAllowed({ EMAIL_PROVIDER: "outbox", NODE_ENV: "development" })).not.toThrow();
    expect(() => assertEmailProviderAllowed({ EMAIL_PROVIDER: "outbox", NODE_ENV: "test" })).not.toThrow();
  });
  it("is refused in production", () => {
    expect(() => assertEmailProviderAllowed({ EMAIL_PROVIDER: "outbox", NODE_ENV: "production" })).toThrow(UnsafeEmailProviderError);
  });
  it("is refused with the real-data switch on (real-data staging), even in development", () => {
    expect(() => assertEmailProviderAllowed({ EMAIL_PROVIDER: "outbox", NODE_ENV: "development", AI_REAL_DATA_ENABLED: "true" })).toThrow(UnsafeEmailProviderError);
  });
  it("is refused on Vercel production and preview deployments", () => {
    expect(() => assertEmailProviderAllowed({ EMAIL_PROVIDER: "outbox", NODE_ENV: "development", VERCEL_ENV: "preview" })).toThrow(UnsafeEmailProviderError);
    expect(() => assertEmailProviderAllowed({ EMAIL_PROVIDER: "outbox", NODE_ENV: "development", VERCEL_ENV: "production" })).toThrow(UnsafeEmailProviderError);
  });
  it("doesn't affect a real provider", () => {
    expect(() => assertEmailProviderAllowed({ NODE_ENV: "production", AI_REAL_DATA_ENABLED: "true" })).not.toThrow();
  });
});
