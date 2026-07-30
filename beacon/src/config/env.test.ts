import { describe, it, expect } from "vitest";
import { loadEnv, EnvValidationError, redactSecrets } from "./env.js";

const VALID = { POLYGON_API_KEY: "pk_live_realkey123456" };

describe("loadEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = loadEnv(VALID as NodeJS.ProcessEnv);
    expect(env.POLYGON_API_KEY).toBe("pk_live_realkey123456");
    expect(env.POLYGON_BASE_URL).toBe("https://api.polygon.io");
    expect(env.BEACON_HTTP_TIMEOUT_MS).toBe(8000);
    expect(env.BEACON_REFRESH_SYMBOLS).toEqual(["NVDA"]);
    // Founder tooling must default to off.
    expect(env.BEACON_ENABLE_FOUNDER_TOOLS).toBe(false);
  });

  it("fails loudly when the provider key is missing", () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(EnvValidationError);
  });

  it("rejects an obvious placeholder key", () => {
    expect(() =>
      loadEnv({ POLYGON_API_KEY: "your-api-key-here" } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it("reports every problem at once rather than only the first", () => {
    try {
      loadEnv({ BEACON_HTTP_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv);
      expect.unreachable("should have thrown");
    } catch (e) {
      const issues = (e as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.join(" ")).toContain("POLYGON_API_KEY");
      expect(issues.join(" ")).toContain("BEACON_HTTP_TIMEOUT_MS");
    }
  });

  it("parses a comma-separated refresh watchlist", () => {
    const env = loadEnv({
      ...VALID,
      BEACON_REFRESH_SYMBOLS: "nvda, aapl ,pltr",
    } as NodeJS.ProcessEnv);
    expect(env.BEACON_REFRESH_SYMBOLS).toEqual(["NVDA", "AAPL", "PLTR"]);
  });

  it("parses boolean-ish founder tool flags", () => {
    for (const on of ["true", "1", "yes", "ON"]) {
      expect(
        loadEnv({ ...VALID, BEACON_ENABLE_FOUNDER_TOOLS: on } as NodeJS.ProcessEnv)
          .BEACON_ENABLE_FOUNDER_TOOLS,
      ).toBe(true);
    }
    for (const off of ["false", "0", "no", ""]) {
      expect(
        loadEnv({ ...VALID, BEACON_ENABLE_FOUNDER_TOOLS: off } as NodeJS.ProcessEnv)
          .BEACON_ENABLE_FOUNDER_TOOLS,
      ).toBe(false);
    }
  });

  it("rejects an out-of-range timeout instead of silently clamping", () => {
    expect(() =>
      loadEnv({ ...VALID, BEACON_HTTP_TIMEOUT_MS: "999999" } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it("strips a trailing slash from the base URL", () => {
    const env = loadEnv({
      ...VALID,
      POLYGON_BASE_URL: "https://api.polygon.io/",
    } as NodeJS.ProcessEnv);
    expect(env.POLYGON_BASE_URL).toBe("https://api.polygon.io");
  });
});

describe("redactSecrets", () => {
  it("removes a known secret value", () => {
    expect(redactSecrets("key=abcdef123456 in use", ["abcdef123456"])).toBe(
      "key=[REDACTED] in use",
    );
  });

  it("redacts keys passed as query parameters even when not known in advance", () => {
    expect(redactSecrets("GET https://api.polygon.io/v2?apiKey=leaked123&x=1")).toBe(
      "GET https://api.polygon.io/v2?apiKey=[REDACTED]&x=1",
    );
  });

  it("redacts bearer tokens", () => {
    expect(redactSecrets("authorization: Bearer abc.def-123")).toBe(
      "authorization: Bearer [REDACTED]",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("nothing sensitive here")).toBe("nothing sensitive here");
  });
});
