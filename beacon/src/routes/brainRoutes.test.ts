import { describe, it, expect } from "vitest";
import { createBeaconBrain, type BeaconBrain } from "../index.js";
import { MemoryStore } from "../repositories/memoryStore.js";
import type { MinimalRequest, MinimalResponse } from "./brainRoutes.js";
import {
  NVDA_TICKER_DETAILS,
  NVDA_SNAPSHOT,
  NVDA_AGGS,
  NVDA_FINANCIALS,
  NVDA_NEWS,
  stubFetch,
  type StubRoute,
} from "../testing/fixtures.js";

const ROUTES: StubRoute[] = [
  { match: "/v3/reference/tickers/", body: NVDA_TICKER_DETAILS },
  { match: "/v2/snapshot/", body: NVDA_SNAPSHOT },
  { match: "/range/1/day/", body: NVDA_AGGS },
  { match: "/vX/reference/financials", body: NVDA_FINANCIALS },
  { match: "/v2/reference/news", body: NVDA_NEWS },
];

/** Captures what a handler sent, standing in for an Express response. */
function mockRes(): MinimalResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return body;
    },
  };
  return res;
}

function req(params: Record<string, string> = {}, query: Record<string, unknown> = {}): MinimalRequest {
  return { params, query };
}

async function makeBrain(opts: {
  founderToolsEnabled?: boolean;
  isFounder?: (req: MinimalRequest) => boolean;
} = {}): Promise<BeaconBrain> {
  const { fetchImpl } = stubFetch(ROUTES);
  const brain = await createBeaconBrain({
    env: {
      POLYGON_API_KEY: "pk_test_realkey1234567",
      BEACON_REFRESH_SYMBOLS: "NVDA",
      BEACON_HTTP_TIMEOUT_MS: "500",
      BEACON_HTTP_MAX_RETRIES: "1",
      BEACON_ENABLE_FOUNDER_TOOLS: opts.founderToolsEnabled === false ? "false" : "true",
    } as NodeJS.ProcessEnv,
    store: new MemoryStore(),
    fetchImpl,
    isFounder: opts.isFounder,
  });
  await brain.services.sources.syncFromProviders(brain.registry);
  return brain;
}

describe("GET /api/brain/assets/:symbol/data-package", () => {
  it("returns 200 with the full package structure", async () => {
    const brain = await makeBrain();
    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "NVDA" }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;

    // The contract the committee agents will code against.
    for (const key of [
      "symbol",
      "assetId",
      "generatedAt",
      "asset",
      "marketSnapshot",
      "historicalPrices",
      "fundamentals",
      "earnings",
      "news",
      "sections",
      "sources",
      "warnings",
      "lastSuccessfulRefresh",
      "complete",
    ]) {
      expect(body, `missing key: ${key}`).toHaveProperty(key);
    }
  });

  it("accepts a lowercase symbol and normalizes it", async () => {
    const brain = await makeBrain();
    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "nvda" }), res);
    expect((res.body as { symbol: string }).symbol).toBe("NVDA");
  });

  it("returns 400 for an invalid symbol", async () => {
    const brain = await makeBrain();
    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "NV DA" }), res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_symbol");
  });

  it("returns 400 for a symbol attempting path traversal", async () => {
    const brain = await makeBrain();
    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "../../admin" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("clamps lookbackDays and newsLimit to sane bounds", async () => {
    const brain = await makeBrain();
    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "NVDA" }, { lookbackDays: "999999", newsLimit: "-5" }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe("founder-only authorization", () => {
  it("denies a manual cache-bypass refresh to a non-founder", async () => {
    const brain = await makeBrain({ isFounder: () => false });
    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "NVDA" }, { refresh: "true" }), res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { code: string }).code).toBe("forbidden");
  });

  it("allows a founder to force a refresh", async () => {
    const brain = await makeBrain({ isFounder: () => true });
    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "NVDA" }, { refresh: "true" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("fails closed when no isFounder hook is wired up", async () => {
    // A missing integration must deny, never default to allowing access.
    const brain = await makeBrain({});
    const res = mockRes();
    await brain.routes.getJobRuns(req(), res);
    expect(res.statusCode).toBe(403);
  });

  it("denies founder routes when the env flag is off, even for a founder", async () => {
    const brain = await makeBrain({ founderToolsEnabled: false, isFounder: () => true });

    const jobRes = mockRes();
    await brain.routes.getJobRuns(req(), jobRes);
    expect(jobRes.statusCode).toBe(403);
    expect((jobRes.body as { error: string }).error).toMatch(/disabled/i);

    const refreshRes = mockRes();
    await brain.routes.postManualRefresh(req(), refreshRes);
    expect(refreshRes.statusCode).toBe(403);
  });

  it("lets a founder read job runs when tools are enabled", async () => {
    const brain = await makeBrain({ isFounder: () => true });
    await brain.scheduler.runNow("refresh-prices");

    const res = mockRes();
    await brain.routes.getJobRuns(req(), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { jobRuns: unknown[] }).jobRuns).toHaveLength(1);
  });

  it("lets a founder trigger a manual refresh", async () => {
    const brain = await makeBrain({ isFounder: () => true });
    const res = mockRes();
    await brain.routes.postManualRefresh(req(), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(await brain.store.countSnapshots("stock:NVDA")).toBe(1);
  });

  it("uses the host app's own auth decision", async () => {
    // Beacon must defer to the app's auth rather than defining its own rule.
    const brain = await makeBrain({ isFounder: (r) => r.query.token === "founder-token" });

    const denied = mockRes();
    await brain.routes.getJobRuns(req({}, { token: "wrong" }), denied);
    expect(denied.statusCode).toBe(403);

    const allowed = mockRes();
    await brain.routes.getJobRuns(req({}, { token: "founder-token" }), allowed);
    expect(allowed.statusCode).toBe(200);
  });
});

describe("GET /api/brain/sources", () => {
  it("returns the registry without exposing credentials", async () => {
    const brain = await makeBrain();
    const res = mockRes();
    await brain.routes.getSources(req(), res);

    expect(res.statusCode).toBe(200);
    const { sources } = res.body as { sources: Array<Record<string, unknown>> };
    expect(sources).toHaveLength(1);
    expect(sources[0]!.providerName).toBe("Polygon.io");

    // No route may ever leak the provider key.
    expect(JSON.stringify(res.body)).not.toContain("pk_test_realkey1234567");
  });
});

describe("error responses", () => {
  it("does not leak internals on an unexpected failure", async () => {
    const brain = await makeBrain();
    // Force an internal error from the service layer.
    (brain.services.dataPackages as unknown as { build: () => Promise<never> }).build = async () => {
      throw new Error("connection string postgres://user:pass@host/db failed");
    };

    const res = mockRes();
    await brain.routes.getDataPackage(req({ symbol: "NVDA" }), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
    expect((res.body as { code: string }).code).toBe("internal_error");
  });
});
