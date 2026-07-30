import { describe, it, expect, beforeEach } from "vitest";
import { createBeaconBrain, type BeaconBrain } from "../index.js";
import { MemoryStore } from "../repositories/memoryStore.js";
import {
  NVDA_TICKER_DETAILS,
  NVDA_SNAPSHOT,
  NVDA_AGGS,
  NVDA_FINANCIALS,
  NVDA_NEWS,
  stubFetch,
  type StubRoute,
} from "../testing/fixtures.js";

/**
 * End-to-end tests over the assembled Brain: provider -> normalizer -> store ->
 * service -> data package. These are the tests that would catch a regression in
 * how sections degrade when a provider misbehaves.
 */

const ENV = {
  POLYGON_API_KEY: "pk_test_realkey1234567",
  BEACON_ENABLE_FOUNDER_TOOLS: "true",
  BEACON_REFRESH_SYMBOLS: "NVDA",
  // Production defaults (8s timeout, 3 retries) would make the failure-path
  // tests take ~30s each of real backoff. The retry logic itself is covered in
  // http.test.ts with a stubbed clock; here we only need it to resolve quickly.
  BEACON_HTTP_TIMEOUT_MS: "500",
  BEACON_HTTP_MAX_RETRIES: "1",
} as NodeJS.ProcessEnv;

const HAPPY_ROUTES: StubRoute[] = [
  { match: "/v3/reference/tickers/", body: NVDA_TICKER_DETAILS },
  { match: "/v2/snapshot/", body: NVDA_SNAPSHOT },
  { match: "/range/1/day/", body: NVDA_AGGS },
  { match: "/vX/reference/financials", body: NVDA_FINANCIALS },
  { match: "/v2/reference/news", body: NVDA_NEWS },
];

async function makeBrain(routes: StubRoute[], store = new MemoryStore()): Promise<BeaconBrain> {
  const { fetchImpl } = stubFetch(routes);
  const brain = await createBeaconBrain({
    env: ENV,
    store,
    fetchImpl,
    isFounder: (req) => req.query.founder === "yes",
  });
  await brain.services.sources.syncFromProviders(brain.registry);
  return brain;
}

describe("data package — happy path", () => {
  let brain: BeaconBrain;

  beforeEach(async () => {
    brain = await makeBrain(HAPPY_ROUTES);
  });

  it("assembles a complete package for NVDA", async () => {
    const pkg = await brain.services.dataPackages.build("nvda");

    expect(pkg.symbol).toBe("NVDA");
    expect(pkg.assetId).toBe("stock:NVDA");
    expect(pkg.complete).toBe(true);

    expect(pkg.asset?.name).toBe("NVIDIA Corporation");
    expect(pkg.asset?.capTier).toBe("mega");
    expect(pkg.marketSnapshot?.price).toBe(131.6);
    expect(pkg.marketSnapshot?.previousClose).toBe(129.25);
    expect(pkg.historicalPrices).toHaveLength(3);
    expect(pkg.fundamentals?.revenue).toBe(35_082_000_000);
    expect(pkg.earnings?.period).toBe("2025Q3");
    expect(pkg.news.length).toBeGreaterThan(0);
  });

  it("reports the provider and freshness for every section", async () => {
    const pkg = await brain.services.dataPackages.build("NVDA");

    for (const section of ["asset", "marketSnapshot", "historicalPrices", "fundamentals", "news", "earnings"] as const) {
      expect(pkg.sections[section].ok, `${section} should be ok`).toBe(true);
      expect(pkg.sections[section].sourceId).toBe("polygon.io");
      expect(pkg.sections[section].providerName).toBe("Polygon.io");
      expect(pkg.sections[section].retrievedAt).toBeTruthy();
    }
  });

  it("includes the contributing source registry entry with attribution", async () => {
    const pkg = await brain.services.dataPackages.build("NVDA");
    expect(pkg.sources).toHaveLength(1);
    expect(pkg.sources[0]!.providerName).toBe("Polygon.io");
    expect(pkg.sources[0]!.attribution).toContain("Polygon.io");
    expect(pkg.sources[0]!.healthStatus).toBe("healthy");
    expect(pkg.lastSuccessfulRefresh).toBeTruthy();
  });

  it("derives 52-week range and average volume from stored bars", async () => {
    const pkg = await brain.services.dataPackages.build("NVDA");
    // Polygon's snapshot does not carry these; they come from the merged bars.
    expect(pkg.marketSnapshot?.fiftyTwoWeekHigh).toBe(129.9);
    expect(pkg.marketSnapshot?.fiftyTwoWeekLow).toBe(119.5);
    expect(pkg.marketSnapshot?.averageVolume).toBe(195_000_000);
  });

  it("de-duplicates a syndicated wire story", async () => {
    const pkg = await brain.services.dataPackages.build("NVDA");
    // Fixture has 3 articles, two of which are the same story.
    expect(pkg.news).toHaveLength(2);
    const headlines = pkg.news.map((n) => n.headline.toLowerCase());
    expect(headlines.some((h) => h.includes("beats expectations"))).toBe(true);
    expect(headlines.some((h) => h.includes("chip sector outlook"))).toBe(true);
  });

  it("persists snapshots as history across repeated builds", async () => {
    await brain.services.dataPackages.build("NVDA");
    await brain.services.dataPackages.build("NVDA");
    await brain.services.dataPackages.build("NVDA");

    // Every build appends; nothing is overwritten.
    expect(await brain.store.countSnapshots("stock:NVDA")).toBe(3);
    expect(await brain.store.listHistoricalPrices("stock:NVDA")).toHaveLength(3);
  });

  it("rejects an invalid symbol before touching a provider", async () => {
    await expect(brain.services.dataPackages.build("NV DA")).rejects.toThrow(/Invalid symbol/);
    await expect(brain.services.dataPackages.build("")).rejects.toThrow(/Invalid symbol/);
  });
});

describe("data package — provider degradation", () => {
  it("keeps prices when fundamentals fail, and says so", async () => {
    const brain = await makeBrain([
      ...HAPPY_ROUTES.filter((r) => r.match !== "/vX/reference/financials"),
      { match: "/vX/reference/financials", status: 500, body: "upstream boom" },
    ]);

    const pkg = await brain.services.dataPackages.build("NVDA");

    // A failed section must not collapse the rest of the package.
    expect(pkg.marketSnapshot?.price).toBe(131.6);
    expect(pkg.sections.marketSnapshot.ok).toBe(true);

    expect(pkg.fundamentals).toBeNull();
    expect(pkg.sections.fundamentals.ok).toBe(false);
    expect(pkg.sections.fundamentals.freshness).toBe("failed");
    expect(pkg.sections.fundamentals.error).toBeTruthy();
    expect(pkg.complete).toBe(false);

    expect(pkg.warnings.some((w) => w.section === "fundamentals" && w.code === "section_failed")).toBe(true);
  });

  it("never substitutes a value for a failed section", async () => {
    const brain = await makeBrain([
      ...HAPPY_ROUTES.filter((r) => r.match !== "/v2/snapshot/"),
      { match: "/v2/snapshot/", status: 500, body: "boom" },
      { match: "/prev", status: 500, body: "boom" },
    ]);

    const pkg = await brain.services.dataPackages.build("NVDA");
    // No last-known price, no zero — an honest null plus an error.
    expect(pkg.marketSnapshot).toBeNull();
    expect(pkg.sections.marketSnapshot.error).toBeTruthy();
  });

  it("falls back to previous close when the snapshot endpoint is not entitled", async () => {
    const brain = await makeBrain([
      ...HAPPY_ROUTES.filter((r) => r.match !== "/v2/snapshot/"),
      { match: "/v2/snapshot/", status: 403, body: "not entitled" },
      {
        match: "/prev",
        body: {
          results: [{ T: "NVDA", o: 127.1, h: 129.9, l: 126.8, c: 129.25, v: 210_000_000, t: 1_733_414_400_000 }],
        },
      },
    ]);

    const pkg = await brain.services.dataPackages.build("NVDA");
    expect(pkg.marketSnapshot?.price).toBe(129.25);
    // Not real-time, and labelled as such rather than passed off as live.
    expect(pkg.sections.marketSnapshot.freshness).toBe("delayed");
    expect(pkg.warnings.some((w) => w.code === "delayed_feed")).toBe(true);
  });

  it("records provider health after a failure", async () => {
    const brain = await makeBrain([
      ...HAPPY_ROUTES.filter((r) => !["/v2/snapshot/", "/range/1/day/"].includes(r.match)),
      { match: "/v2/snapshot/", status: 500, body: "boom" },
      { match: "/prev", status: 500, body: "boom" },
      { match: "/range/1/day/", status: 500, body: "boom" },
    ]);

    await brain.services.dataPackages.build("NVDA");
    const source = await brain.services.sources.get("polygon.io");
    expect(source!.consecutiveFailures).toBeGreaterThan(0);
    expect(source!.lastFailedRefresh).toBeTruthy();
    expect(source!.lastFailureReason).toBeTruthy();
  });

  it("surfaces a rate limit as an honest failure rather than empty data", async () => {
    const brain = await makeBrain([
      ...HAPPY_ROUTES.filter((r) => r.match !== "/v2/reference/news"),
      { match: "/v2/reference/news", status: 429, headers: { "retry-after": "1" }, body: "slow down" },
    ]);

    const pkg = await brain.services.dataPackages.build("NVDA");
    expect(pkg.news).toEqual([]);
    expect(pkg.sections.news.ok).toBe(false);
    expect(pkg.sections.news.error).toMatch(/rate limit/i);
  });

  it("times out slow providers without hanging the package", async () => {
    const brain = await makeBrain([
      ...HAPPY_ROUTES.filter((r) => r.match !== "/v2/reference/news"),
      { match: "/v2/reference/news", hang: true },
    ]);

    const pkg = await brain.services.dataPackages.build("NVDA");
    expect(pkg.sections.news.ok).toBe(false);
    expect(pkg.sections.news.error).toMatch(/timed out/i);
    // The rest of the package still assembled.
    expect(pkg.marketSnapshot?.price).toBe(131.6);
  });

  it("reports missing fields the provider did not supply", async () => {
    const brain = await makeBrain(HAPPY_ROUTES);
    const pkg = await brain.services.dataPackages.build("NVDA");
    // Polygon exposes no sector concept — it must be reported, not guessed.
    expect(pkg.asset?.sector).toBeNull();
    expect(pkg.warnings.some((w) => w.code === "missing_fields" && w.message.includes("sector"))).toBe(true);
  });
});

describe("refresh job", () => {
  it("runs, stores data, and records a successful run", async () => {
    const brain = await makeBrain(HAPPY_ROUTES);
    await brain.scheduler.runNow("refresh-prices");

    const runs = await brain.store.listJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("success");
    expect(runs[0]!.symbolsProcessed).toEqual(["NVDA"]);
    expect(runs[0]!.durationMs).toBeGreaterThanOrEqual(0);

    expect(await brain.store.countSnapshots("stock:NVDA")).toBe(1);
  });

  it("records a partial run when a section fails", async () => {
    const brain = await makeBrain([
      ...HAPPY_ROUTES.filter((r) => r.match !== "/range/1/day/"),
      { match: "/range/1/day/", status: 500, body: "boom" },
    ]);

    await brain.scheduler.runNow("refresh-prices");
    const runs = await brain.store.listJobRuns();
    expect(runs[0]!.status).toBe("partial");
    expect(runs[0]!.errors.length).toBeGreaterThan(0);
    expect(runs[0]!.errors[0]!.code).toBe("historical");
  });

  it("preserves prior history across repeated runs", async () => {
    const brain = await makeBrain(HAPPY_ROUTES);
    await brain.scheduler.runNow("refresh-prices");
    await brain.scheduler.runNow("refresh-prices");

    expect(await brain.store.countSnapshots("stock:NVDA")).toBe(2);
    // Bars are deduped, so re-running does not duplicate history.
    expect(await brain.store.listHistoricalPrices("stock:NVDA")).toHaveLength(3);
  });
});
