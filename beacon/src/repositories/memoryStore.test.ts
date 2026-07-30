import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "./memoryStore.js";
import type { Asset } from "../types/asset.js";
import type { MarketSnapshot } from "../types/marketSnapshot.js";
import type { HistoricalPrice } from "../types/historicalPrice.js";
import type { NewsItem } from "../types/newsItem.js";
import type { FundamentalSnapshot } from "../types/fundamentals.js";

const ASSET: Asset = {
  assetId: "stock:NVDA",
  symbol: "NVDA",
  name: "NVIDIA Corporation",
  assetType: "stock",
  exchange: "XNAS",
  currency: "USD",
  sector: null,
  industry: "Semiconductors",
  marketCap: 3_120_000_000_000,
  capTier: "mega",
  active: true,
  createdAt: "2024-12-01T00:00:00.000Z",
  updatedAt: "2024-12-01T00:00:00.000Z",
};

function snapshot(price: number, retrievedAt: string): MarketSnapshot {
  return {
    snapshotId: `stock:NVDA|${retrievedAt}`,
    assetId: "stock:NVDA",
    symbol: "NVDA",
    price,
    previousClose: 129.25,
    change: null,
    changePercent: null,
    open: null,
    high: null,
    low: null,
    volume: null,
    averageVolume: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    marketTimestamp: retrievedAt,
    provenance: {
      sourceId: "polygon.io",
      dataTimestamp: retrievedAt,
      retrievedAt,
      freshness: "fresh",
    },
    missingFields: [],
  };
}

function bar(date: string, close: number): HistoricalPrice {
  return {
    assetId: "stock:NVDA",
    symbol: "NVDA",
    date,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    adjustedClose: null,
    volume: 1_000_000,
    sourceId: "polygon.io",
    retrievedAt: "2024-12-06T16:00:00.000Z",
  };
}

describe("MemoryStore — assets", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("upserts and reads back by id and symbol", async () => {
    await store.upsertAsset(ASSET);
    expect(await store.getAssetById("stock:NVDA")).toMatchObject({ symbol: "NVDA" });
    expect(await store.getAssetBySymbol("nvda")).toMatchObject({ assetId: "stock:NVDA" });
  });

  it("preserves the original createdAt across updates", async () => {
    await store.upsertAsset(ASSET);
    await store.upsertAsset({
      ...ASSET,
      name: "NVIDIA Corp",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });

    const stored = await store.getAssetById("stock:NVDA");
    expect(stored!.name).toBe("NVIDIA Corp");
    expect(stored!.createdAt).toBe("2024-12-01T00:00:00.000Z");
    expect(stored!.updatedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns null for unknown assets rather than inventing one", async () => {
    expect(await store.getAssetById("stock:NOPE")).toBeNull();
    expect(await store.getAssetBySymbol("NOPE")).toBeNull();
  });

  it("hands out copies so callers cannot mutate stored state", async () => {
    await store.upsertAsset(ASSET);
    const a = await store.getAssetById("stock:NVDA");
    a!.name = "MUTATED";
    expect((await store.getAssetById("stock:NVDA"))!.name).toBe("NVIDIA Corporation");
  });
});

describe("MemoryStore — snapshot history", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("appends rather than overwriting, preserving every observation", async () => {
    // This is the guarantee that lets Beacon reconstruct what it knew when a
    // past recommendation was made.
    await store.appendSnapshot(snapshot(120, "2024-12-06T15:00:00.000Z"));
    await store.appendSnapshot(snapshot(125, "2024-12-06T15:30:00.000Z"));
    await store.appendSnapshot(snapshot(131.6, "2024-12-06T16:00:00.000Z"));

    expect(await store.countSnapshots("stock:NVDA")).toBe(3);

    const history = await store.listSnapshots("stock:NVDA");
    expect(history.map((s) => s.price)).toEqual([131.6, 125, 120]);
  });

  it("returns the newest snapshot by retrieval time, not insertion order", async () => {
    await store.appendSnapshot(snapshot(131.6, "2024-12-06T16:00:00.000Z"));
    // A late-arriving backfill of an older reading must not become "latest".
    await store.appendSnapshot(snapshot(120, "2024-12-06T15:00:00.000Z"));

    const latest = await store.getLatestSnapshot("stock:NVDA");
    expect(latest!.price).toBe(131.6);
  });

  it("returns null when no snapshot exists", async () => {
    expect(await store.getLatestSnapshot("stock:NVDA")).toBeNull();
    expect(await store.countSnapshots("stock:NVDA")).toBe(0);
  });
});

describe("MemoryStore — historical bars", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("merges new days without duplicating existing ones", async () => {
    expect(await store.upsertHistoricalPrices([bar("2024-12-02", 123.4), bar("2024-12-03", 127.1)])).toBe(2);
    // Overlapping refetch: only the genuinely new day is written.
    expect(await store.upsertHistoricalPrices([bar("2024-12-03", 127.1), bar("2024-12-04", 129.25)])).toBe(1);

    const bars = await store.listHistoricalPrices("stock:NVDA");
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.date)).toEqual(["2024-12-02", "2024-12-03", "2024-12-04"]);
  });

  it("keeps a filed bar immutable when the provider resends it changed", async () => {
    await store.upsertHistoricalPrices([bar("2024-12-02", 123.4)]);
    await store.upsertHistoricalPrices([bar("2024-12-02", 999)]);

    const bars = await store.listHistoricalPrices("stock:NVDA");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBe(123.4);
  });

  it("keeps bars from different sources side by side", async () => {
    await store.upsertHistoricalPrices([bar("2024-12-02", 123.4)]);
    await store.upsertHistoricalPrices([{ ...bar("2024-12-02", 123.5), sourceId: "other-provider" }]);
    expect(await store.listHistoricalPrices("stock:NVDA")).toHaveLength(2);
  });

  it("returns bars sorted ascending by date", async () => {
    await store.upsertHistoricalPrices([bar("2024-12-04", 129), bar("2024-12-02", 123), bar("2024-12-03", 127)]);
    expect((await store.listHistoricalPrices("stock:NVDA")).map((b) => b.date)).toEqual([
      "2024-12-02",
      "2024-12-03",
      "2024-12-04",
    ]);
  });
});

describe("MemoryStore — news de-duplication", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  function news(articleId: string, headline: string, publishedAt: string): NewsItem {
    return {
      articleId,
      headline,
      summary: null,
      publisher: "Outlet",
      publishedAt,
      relatedAssetIds: ["stock:NVDA"],
      relatedSymbols: ["NVDA"],
      sourceUrl: null,
      provenance: {
        sourceId: "polygon.io",
        dataTimestamp: publishedAt,
        retrievedAt: "2024-12-06T16:00:00.000Z",
        freshness: "fresh",
      },
      verificationStatus: "unverified",
      duplicateGroupId: null,
    };
  }

  it("assigns one duplicate group to the same story across outlets", async () => {
    const stored = await store.upsertNews([
      news("a", "NVIDIA beats expectations on data centre demand", "2024-11-21T10:00:00Z"),
      news("b", "NVIDIA Beats Expectations on Data Centre Demand!", "2024-11-21T11:30:00Z"),
      news("c", "Chip sector outlook for 2025", "2024-11-20T08:00:00Z"),
    ]);

    expect(stored[0]!.duplicateGroupId).toBe("a");
    // Case and punctuation differences must not read as independent coverage.
    expect(stored[1]!.duplicateGroupId).toBe("a");
    expect(stored[2]!.duplicateGroupId).toBe("c");
  });

  it("does not regress a corroborated article on re-ingest", async () => {
    await store.upsertNews([{ ...news("a", "Headline one", "2024-11-21T10:00:00Z"), verificationStatus: "corroborated" }]);
    const again = await store.upsertNews([news("a", "Headline one", "2024-11-21T10:00:00Z")]);
    expect(again[0]!.verificationStatus).toBe("corroborated");
  });

  it("lists news newest-first for an asset", async () => {
    await store.upsertNews([
      news("a", "Older story", "2024-11-20T08:00:00Z"),
      news("b", "Newer story", "2024-11-21T10:00:00Z"),
    ]);
    const items = await store.listNews("stock:NVDA");
    expect(items.map((i) => i.articleId)).toEqual(["b", "a"]);
  });
});

describe("MemoryStore — fundamentals and job runs", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  function fundamentals(period: string, revenue: number, retrievedAt: string): FundamentalSnapshot {
    return {
      fundamentalId: `stock:NVDA|${period}|${retrievedAt}`,
      assetId: "stock:NVDA",
      symbol: "NVDA",
      revenue,
      earnings: null,
      eps: null,
      profitMargin: null,
      cash: null,
      debt: null,
      valuation: { peRatio: null, priceToSales: null, priceToBook: null, enterpriseValue: null },
      reportingPeriod: period,
      fiscalPeriodEnd: "2024-10-27",
      provenance: {
        sourceId: "polygon.io",
        dataTimestamp: "2024-10-27",
        retrievedAt,
        freshness: "fresh",
      },
      missingFields: [],
    };
  }

  it("keeps a restatement alongside the original rather than replacing it", async () => {
    await store.appendFundamentals(fundamentals("2025Q3", 35_082_000_000, "2024-12-01T00:00:00.000Z"));
    await store.appendFundamentals(fundamentals("2025Q3", 35_100_000_000, "2024-12-15T00:00:00.000Z"));

    const all = await store.listFundamentals("stock:NVDA");
    expect(all).toHaveLength(2);
    expect((await store.getLatestFundamentals("stock:NVDA"))!.revenue).toBe(35_100_000_000);
  });

  it("records job runs newest-first", async () => {
    await store.recordJobRun({
      jobRunId: "1",
      jobName: "refresh-prices",
      startedAt: "2024-12-06T15:00:00.000Z",
      finishedAt: "2024-12-06T15:00:05.000Z",
      status: "success",
      symbolsProcessed: ["NVDA"],
      errors: [],
      durationMs: 5000,
    });
    await store.recordJobRun({
      jobRunId: "2",
      jobName: "refresh-prices",
      startedAt: "2024-12-06T16:00:00.000Z",
      finishedAt: null,
      status: "failed",
      symbolsProcessed: [],
      errors: [{ symbol: "NVDA", message: "timeout" }],
      durationMs: null,
    });

    const runs = await store.listJobRuns();
    expect(runs.map((r) => r.jobRunId)).toEqual(["2", "1"]);
    expect(runs[0]!.errors[0]!.message).toBe("timeout");
  });
});
