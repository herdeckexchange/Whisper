import { describe, it, expect } from "vitest";
import {
  normalizeAsset,
  normalizeMarketSnapshot,
  normalizePrevCloseSnapshot,
  normalizeHistorical,
  normalizeFundamentals,
  normalizeNews,
  deriveRangeStats,
  nanosToIso,
  msToIso,
  mapAssetType,
  POLYGON_SOURCE_ID,
} from "./polygonNormalizer.js";
import {
  NVDA_TICKER_DETAILS,
  NVDA_SNAPSHOT,
  NVDA_SNAPSHOT_PREOPEN,
  NVDA_PREV_CLOSE,
  NVDA_AGGS,
  NVDA_FINANCIALS,
  NVDA_NEWS,
} from "../testing/fixtures.js";
import type { Provenance } from "../types/provenance.js";

const RETRIEVED_AT = "2024-12-06T16:00:00.000Z";

const provenance: Provenance = {
  sourceId: POLYGON_SOURCE_ID,
  dataTimestamp: null,
  retrievedAt: RETRIEVED_AT,
  freshness: "fresh",
  attribution: "Market data provided by Polygon.io",
};

describe("timestamp coercion", () => {
  it("converts Polygon nanosecond epochs to ISO", () => {
    expect(nanosToIso(1_733_500_800_000_000_000)).toBe("2024-12-06T16:00:00.000Z");
  });

  it("converts millisecond epochs to ISO", () => {
    expect(msToIso(1_733_500_800_000)).toBe("2024-12-06T16:00:00.000Z");
  });

  it("treats zero and non-numeric timestamps as absent", () => {
    expect(nanosToIso(0)).toBeNull();
    expect(msToIso(undefined)).toBeNull();
    expect(msToIso("nope")).toBeNull();
  });
});

describe("asset type mapping", () => {
  it("maps Polygon instrument codes onto Beacon asset types", () => {
    expect(mapAssetType("CS")).toBe("stock");
    expect(mapAssetType("ETF")).toBe("etf");
    expect(mapAssetType("ADRC")).toBe("adr");
    expect(mapAssetType("INDEX")).toBe("index");
  });

  it("falls back to the market when the code is unknown", () => {
    expect(mapAssetType("WEIRD", "crypto")).toBe("crypto");
    expect(mapAssetType(undefined, "options")).toBe("option");
    expect(mapAssetType(undefined, undefined)).toBe("other");
  });
});

describe("normalizeAsset", () => {
  it("maps a ticker details payload into a Beacon asset", () => {
    const result = normalizeAsset(NVDA_TICKER_DETAILS, "NVDA", RETRIEVED_AT);
    expect(result).not.toBeNull();

    const { asset, missingFields } = result!;
    expect(asset.assetId).toBe("stock:NVDA");
    expect(asset.symbol).toBe("NVDA");
    expect(asset.name).toBe("NVIDIA Corporation");
    expect(asset.assetType).toBe("stock");
    expect(asset.exchange).toBe("XNAS");
    expect(asset.currency).toBe("USD");
    expect(asset.industry).toBe("Semiconductors & Related Devices");
    expect(asset.marketCap).toBe(3_120_000_000_000);
    expect(asset.capTier).toBe("mega");
    expect(asset.active).toBe(true);
    expect(asset.externalIds).toEqual({ [POLYGON_SOURCE_ID]: "NVDA" });

    // Polygon has no sector concept, so it is reported missing rather than guessed.
    expect(asset.sector).toBeNull();
    expect(missingFields).toContain("sector");
  });

  it("returns null when the provider sends no results envelope", () => {
    expect(normalizeAsset({}, "NVDA", RETRIEVED_AT)).toBeNull();
  });

  it("reports absent optional fields instead of inventing them", () => {
    const result = normalizeAsset(
      { results: { ticker: "TINY", type: "CS", market: "stocks" } },
      "TINY",
      RETRIEVED_AT,
    );
    const { asset, missingFields } = result!;
    expect(asset.name).toBeNull();
    expect(asset.marketCap).toBeNull();
    expect(asset.capTier).toBe("unknown");
    expect(missingFields).toEqual(expect.arrayContaining(["name", "exchange", "marketCap", "industry"]));
  });
});

describe("normalizeMarketSnapshot", () => {
  it("maps a mid-session snapshot", () => {
    const out = normalizeMarketSnapshot({
      payload: NVDA_SNAPSHOT,
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });

    expect(out).not.toBeNull();
    const { snapshot } = out!;
    expect(snapshot.price).toBe(131.6);
    expect(snapshot.previousClose).toBe(129.25);
    expect(snapshot.open).toBe(129.5);
    expect(snapshot.high).toBe(132.4);
    expect(snapshot.low).toBe(128.9);
    expect(snapshot.volume).toBe(245_000_000);
    expect(snapshot.change).toBe(2.35);
    expect(snapshot.changePercent).toBe(1.82);
    expect(snapshot.marketTimestamp).toBe("2024-12-06T16:00:00.000Z");
  });

  it("never publishes Polygon's pre-open zeros as a real price", () => {
    const out = normalizeMarketSnapshot({
      payload: NVDA_SNAPSHOT_PREOPEN,
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });

    const { snapshot } = out!;
    // A traded instrument cannot be worth $0 — these must be null, not zero.
    expect(snapshot.price).toBeNull();
    expect(snapshot.open).toBeNull();
    expect(snapshot.high).toBeNull();
    expect(snapshot.low).toBeNull();
    expect(snapshot.volume).toBeNull();
    expect(snapshot.missingFields).toEqual(
      expect.arrayContaining(["price", "open", "high", "low", "volume"]),
    );
    // Previous close is genuine even before the open.
    expect(snapshot.previousClose).toBe(129.25);
  });

  it("always marks fields Polygon's snapshot cannot supply as missing", () => {
    const out = normalizeMarketSnapshot({
      payload: NVDA_SNAPSHOT,
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });
    expect(out!.snapshot.missingFields).toEqual(
      expect.arrayContaining(["averageVolume", "fiftyTwoWeekHigh", "fiftyTwoWeekLow"]),
    );
  });

  it("derives change only when both inputs are present", () => {
    const payload = {
      ticker: {
        ticker: "X",
        updated: 1_733_500_800_000_000_000,
        day: { c: 50 },
        prevDay: {},
        lastTrade: { p: 50 },
      },
    };
    const out = normalizeMarketSnapshot({
      payload,
      symbol: "X",
      assetId: "stock:X",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });
    // No previous close means no honest change figure — not a fabricated 0.
    expect(out!.snapshot.change).toBeNull();
    expect(out!.snapshot.changePercent).toBeNull();
  });

  it("returns null when the ticker envelope is absent", () => {
    expect(
      normalizeMarketSnapshot({
        payload: {},
        symbol: "NVDA",
        assetId: "stock:NVDA",
        retrievedAt: RETRIEVED_AT,
        provenance,
      }),
    ).toBeNull();
  });
});

describe("normalizePrevCloseSnapshot", () => {
  it("maps the fallback previous-close payload", () => {
    const out = normalizePrevCloseSnapshot({
      payload: NVDA_PREV_CLOSE,
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });

    const { snapshot } = out!;
    expect(snapshot.price).toBe(129.25);
    // This payload holds one session, so there is no prior close to compare to.
    expect(snapshot.previousClose).toBeNull();
    expect(snapshot.change).toBeNull();
    expect(snapshot.missingFields).toEqual(expect.arrayContaining(["change", "changePercent"]));
  });

  it("returns null on an empty results array", () => {
    expect(
      normalizePrevCloseSnapshot({
        payload: { results: [] },
        symbol: "NVDA",
        assetId: "stock:NVDA",
        retrievedAt: RETRIEVED_AT,
        provenance,
      }),
    ).toBeNull();
  });
});

describe("normalizeHistorical", () => {
  it("maps and sorts daily bars ascending", () => {
    const bars = normalizeHistorical(NVDA_AGGS, {
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
    });

    expect(bars).toHaveLength(3);
    expect(bars[0]!.date).toBe("2024-12-02");
    expect(bars[2]!.date).toBe("2024-12-05");
    expect(bars[2]!.close).toBe(129.25);
    expect(bars[0]!.sourceId).toBe(POLYGON_SOURCE_ID);
  });

  it("drops bars with no usable timestamp rather than guessing a date", () => {
    const bars = normalizeHistorical(
      { results: [{ o: 1, h: 2, l: 1, c: 2, v: 10 }, ...NVDA_AGGS.results] },
      { symbol: "NVDA", assetId: "stock:NVDA", retrievedAt: RETRIEVED_AT },
    );
    expect(bars).toHaveLength(3);
  });

  it("returns an empty array for a missing results field", () => {
    expect(
      normalizeHistorical({}, { symbol: "NVDA", assetId: "stock:NVDA", retrievedAt: RETRIEVED_AT }),
    ).toEqual([]);
  });
});

describe("deriveRangeStats", () => {
  it("computes 52-week range and average volume from stored bars", () => {
    const bars = normalizeHistorical(NVDA_AGGS, {
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
    });
    const stats = deriveRangeStats(bars);

    expect(stats.fiftyTwoWeekHigh).toBe(129.9);
    expect(stats.fiftyTwoWeekLow).toBe(119.5);
    expect(stats.averageVolume).toBe(Math.round((180_000_000 + 195_000_000 + 210_000_000) / 3));
  });

  it("returns nulls rather than zeros when there are no bars", () => {
    expect(deriveRangeStats([])).toEqual({
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      averageVolume: null,
    });
  });
});

describe("normalizeFundamentals", () => {
  it("maps filed financials and derives profit margin", () => {
    const out = normalizeFundamentals(NVDA_FINANCIALS, {
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });

    const { fundamentals } = out!;
    expect(fundamentals.revenue).toBe(35_082_000_000);
    expect(fundamentals.earnings).toBe(19_309_000_000);
    // Diluted EPS is preferred over basic.
    expect(fundamentals.eps).toBe(0.78);
    expect(fundamentals.cash).toBe(9_107_000_000);
    expect(fundamentals.reportingPeriod).toBe("2025Q3");
    expect(fundamentals.fiscalPeriodEnd).toBe("2024-10-27");
    expect(fundamentals.profitMargin).toBeCloseTo(0.5504, 3);
  });

  it("marks valuation multiples missing — Polygon's financials do not carry them", () => {
    const out = normalizeFundamentals(NVDA_FINANCIALS, {
      symbol: "NVDA",
      assetId: "stock:NVDA",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });
    expect(out!.fundamentals.valuation.peRatio).toBeNull();
    expect(out!.fundamentals.missingFields).toEqual(
      expect.arrayContaining(["peRatio", "priceToSales", "priceToBook", "enterpriseValue"]),
    );
  });

  it("does not compute a margin when revenue is absent", () => {
    const out = normalizeFundamentals(
      {
        results: [
          {
            fiscal_period: "Q1",
            fiscal_year: "2025",
            end_date: "2025-01-01",
            financials: { income_statement: { net_income_loss: { value: 100 } } },
          },
        ],
      },
      { symbol: "X", assetId: "stock:X", retrievedAt: RETRIEVED_AT, provenance },
    );
    expect(out!.fundamentals.profitMargin).toBeNull();
    expect(out!.fundamentals.missingFields).toContain("revenue");
  });

  it("returns null when no financials are filed", () => {
    expect(
      normalizeFundamentals(
        { results: [] },
        { symbol: "X", assetId: "stock:X", retrievedAt: RETRIEVED_AT, provenance },
      ),
    ).toBeNull();
  });
});

describe("normalizeNews", () => {
  it("maps articles and always associates the requested symbol", () => {
    const items = normalizeNews(NVDA_NEWS, {
      assetId: "stock:NVDA",
      symbol: "NVDA",
      retrievedAt: RETRIEVED_AT,
      provenance,
    });

    expect(items).toHaveLength(3);
    expect(items[0]!.headline).toBe("NVIDIA beats expectations on data centre demand");
    expect(items[0]!.publisher).toBe("Example Wire");
    expect(items[0]!.relatedSymbols).toContain("NVDA");
    expect(items[2]!.relatedSymbols).toEqual(expect.arrayContaining(["NVDA", "AMD"]));
    // A single provider cannot corroborate itself.
    expect(items.every((i) => i.verificationStatus === "unverified")).toBe(true);
  });

  it("skips articles with no headline", () => {
    const items = normalizeNews(
      { results: [{ id: "x", published_utc: "2024-01-01T00:00:00Z" }] },
      { assetId: "stock:NVDA", symbol: "NVDA", retrievedAt: RETRIEVED_AT, provenance },
    );
    expect(items).toEqual([]);
  });
});
