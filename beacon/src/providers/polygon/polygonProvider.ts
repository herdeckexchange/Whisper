import { getJson } from "../../lib/http.js";
import { TtlCache } from "../../lib/cache.js";
import { ProviderError, isProviderError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { silentLogger } from "../../lib/logger.js";
import { normalizeSymbol } from "../../lib/symbol.js";
import type { DataCategory, DataSource } from "../../types/dataSource.js";
import type { Provenance } from "../../types/provenance.js";
import type {
  FetchContext,
  HistoricalRequest,
  MarketDataProvider,
  NewsRequest,
  ProviderResult,
} from "../types.js";
import { emptyResult } from "../types.js";
import type { Asset } from "../../types/asset.js";
import type { MarketSnapshot } from "../../types/marketSnapshot.js";
import type { HistoricalPrice } from "../../types/historicalPrice.js";
import type { FundamentalSnapshot, EarningsInfo } from "../../types/fundamentals.js";
import type { NewsItem } from "../../types/newsItem.js";
import {
  POLYGON_SOURCE_ID,
  normalizeAsset,
  normalizeEarnings,
  normalizeFundamentals,
  normalizeHistorical,
  normalizeMarketSnapshot,
  normalizeNews,
  normalizePrevCloseSnapshot,
  type PolygonAggs,
  type PolygonFinancials,
  type PolygonNews,
  type PolygonPrevClose,
  type PolygonSnapshot,
  type PolygonTickerDetails,
} from "../../normalizers/polygonNormalizer.js";

/**
 * Polygon.io adapter.
 *
 * Chosen for the first slice because its coverage extends across the whole US
 * market — micro-caps and sub-$10 names included — which Beacon requires and
 * which quote-only vendors do not provide.
 *
 * The adapter owns transport and shape; it delegates all field mapping to the
 * normalizer, and it never decides policy (what is stale, what to store).
 */

const SUPPORTED: DataCategory[] = [
  "market_price",
  "historical_price",
  "fundamentals",
  "news",
  "earnings",
];

export interface PolygonProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export class PolygonProvider implements MarketDataProvider {
  public readonly descriptor: DataSource;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #logger: Logger;
  readonly #fetchImpl?: typeof fetch;
  readonly #sleepImpl?: (ms: number) => Promise<void>;
  readonly #cache: TtlCache<unknown>;

  constructor(opts: PolygonProviderOptions) {
    if (!opts.apiKey) {
      throw new Error("PolygonProvider requires an apiKey.");
    }
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? "https://api.polygon.io").replace(/\/+$/, "");
    this.#timeoutMs = opts.timeoutMs ?? 8_000;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#logger = (opts.logger ?? silentLogger()).child({ provider: POLYGON_SOURCE_ID });
    this.#fetchImpl = opts.fetchImpl;
    this.#sleepImpl = opts.sleepImpl;
    this.#cache = new TtlCache<unknown>(opts.cacheTtlMs ?? 60_000);

    this.descriptor = {
      sourceId: POLYGON_SOURCE_ID,
      providerName: "Polygon.io",
      categories: [...SUPPORTED],
      providerType: "third_party",
      // Polygon aggregates exchange data; it is not the originating exchange.
      official: false,
      reliabilityTier: 2,
      refreshFrequencyMs: 60_000,
      lastSuccessfulRefresh: null,
      lastFailedRefresh: null,
      lastFailureReason: null,
      healthStatus: "unknown",
      licensingNotes:
        "Polygon.io licence requires attribution when market data is displayed to end users.",
      attribution: "Market data provided by Polygon.io",
      backupSourceId: null,
      consecutiveFailures: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  supports(category: DataCategory): boolean {
    return SUPPORTED.includes(category);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * The API key travels in the Authorization header rather than the query
   * string, so it cannot leak through logged URLs, proxy access logs, or
   * provider-side request histories.
   */
  async #get<T>(path: string, ctx?: FetchContext, cacheKey?: string): Promise<{ data: T; retrievedAt: string }> {
    if (cacheKey && !ctx?.bypassCache) {
      const hit = this.#cache.get(cacheKey) as { data: T; retrievedAt: string } | undefined;
      if (hit) {
        this.#logger.debug("provider cache hit", { cacheKey });
        return hit;
      }
    }

    const res = await getJson<T>({
      url: `${this.#baseUrl}${path}`,
      sourceId: POLYGON_SOURCE_ID,
      timeoutMs: this.#timeoutMs,
      maxRetries: this.#maxRetries,
      headers: { authorization: `Bearer ${this.#apiKey}` },
      logger: this.#logger,
      fetchImpl: this.#fetchImpl,
      sleepImpl: this.#sleepImpl,
      signal: ctx?.signal,
    });

    const out = { data: res.data, retrievedAt: res.retrievedAt };
    if (cacheKey) this.#cache.set(cacheKey, out);
    return out;
  }

  #provenance(retrievedAt: string): Provenance {
    return {
      sourceId: POLYGON_SOURCE_ID,
      dataTimestamp: null,
      retrievedAt,
      // The service layer classifies freshness; the adapter only reports facts.
      freshness: "fresh",
      attribution: this.descriptor.attribution,
    };
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async fetchAssetProfile(symbol: string, ctx?: FetchContext): Promise<ProviderResult<Asset>> {
    const s = normalizeSymbol(symbol);
    const { data, retrievedAt } = await this.#get<PolygonTickerDetails>(
      `/v3/reference/tickers/${encodeURIComponent(s)}`,
      ctx,
      `profile:${s}`,
    );

    const normalized = normalizeAsset(data, s, retrievedAt);
    if (!normalized) {
      return emptyResult<Asset>(POLYGON_SOURCE_ID, retrievedAt, "Provider returned no ticker details.");
    }

    return {
      data: normalized.asset,
      sourceId: POLYGON_SOURCE_ID,
      retrievedAt,
      // Reference data has no meaningful measurement time of its own.
      dataTimestamp: null,
      missingFields: normalized.missingFields,
    };
  }

  async fetchMarketSnapshot(symbol: string, ctx?: FetchContext): Promise<ProviderResult<MarketSnapshot>> {
    const s = normalizeSymbol(symbol);
    const assetId = `stock:${s}`;

    try {
      const { data, retrievedAt } = await this.#get<PolygonSnapshot>(
        `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(s)}`,
        ctx,
        `snapshot:${s}`,
      );

      const normalized = normalizeMarketSnapshot({
        payload: data,
        symbol: s,
        assetId,
        retrievedAt,
        provenance: this.#provenance(retrievedAt),
      });

      if (normalized) {
        return {
          data: normalized.snapshot,
          sourceId: POLYGON_SOURCE_ID,
          retrievedAt,
          dataTimestamp: normalized.dataTimestamp,
          missingFields: normalized.snapshot.missingFields,
        };
      }
      // Fall through to the previous-close path below.
    } catch (e) {
      // Free and starter Polygon plans are not entitled to the real-time
      // snapshot endpoint. That is a plan limitation, not an outage, so fall
      // back to the previous close rather than failing the whole package.
      if (!isProviderError(e) || !["unauthorized", "not_found"].includes(e.code)) {
        throw e;
      }
      this.#logger.warn("snapshot endpoint unavailable, falling back to previous close", {
        symbol: s,
        code: e.code,
      });
    }

    return this.#fetchPrevCloseSnapshot(s, assetId, ctx);
  }

  async #fetchPrevCloseSnapshot(
    s: string,
    assetId: string,
    ctx?: FetchContext,
  ): Promise<ProviderResult<MarketSnapshot>> {
    const { data, retrievedAt } = await this.#get<PolygonPrevClose>(
      `/v2/aggs/ticker/${encodeURIComponent(s)}/prev?adjusted=true`,
      ctx,
      `prev:${s}`,
    );

    const normalized = normalizePrevCloseSnapshot({
      payload: data,
      symbol: s,
      assetId,
      retrievedAt,
      provenance: this.#provenance(retrievedAt),
    });

    if (!normalized) {
      return emptyResult<MarketSnapshot>(
        POLYGON_SOURCE_ID,
        retrievedAt,
        "Provider returned no market data for this symbol.",
      );
    }

    return {
      data: normalized.snapshot,
      sourceId: POLYGON_SOURCE_ID,
      retrievedAt,
      dataTimestamp: normalized.dataTimestamp,
      missingFields: normalized.snapshot.missingFields,
      note: "Real-time snapshot unavailable on this plan; value is the last completed session's close.",
    };
  }

  async fetchHistoricalPrices(
    symbol: string,
    opts: HistoricalRequest,
    ctx?: FetchContext,
  ): Promise<ProviderResult<HistoricalPrice[]>> {
    const s = normalizeSymbol(symbol);
    const to = new Date();
    const from = new Date(to.getTime() - opts.lookbackDays * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const { data, retrievedAt } = await this.#get<PolygonAggs>(
      `/v2/aggs/ticker/${encodeURIComponent(s)}/range/1/day/${fmt(from)}/${fmt(to)}` +
        `?adjusted=true&sort=asc&limit=50000`,
      ctx,
      `aggs:${s}:${opts.lookbackDays}:${fmt(to)}`,
    );

    const bars = normalizeHistorical(data, { symbol: s, assetId: `stock:${s}`, retrievedAt });

    return {
      data: bars,
      sourceId: POLYGON_SOURCE_ID,
      retrievedAt,
      dataTimestamp: bars.length ? `${bars[bars.length - 1]!.date}T00:00:00.000Z` : null,
      missingFields: bars.length ? [] : ["historicalPrices"],
      ...(bars.length ? {} : { note: "Provider returned no bars for the requested window." }),
    };
  }

  async fetchFundamentals(symbol: string, ctx?: FetchContext): Promise<ProviderResult<FundamentalSnapshot>> {
    const s = normalizeSymbol(symbol);
    const { data, retrievedAt } = await this.#get<PolygonFinancials>(
      `/vX/reference/financials?ticker=${encodeURIComponent(s)}&limit=1&sort=period_of_report_date&order=desc`,
      ctx,
      `fundamentals:${s}`,
    );

    const normalized = normalizeFundamentals(data, {
      symbol: s,
      assetId: `stock:${s}`,
      retrievedAt,
      provenance: this.#provenance(retrievedAt),
    });

    if (!normalized) {
      return emptyResult<FundamentalSnapshot>(
        POLYGON_SOURCE_ID,
        retrievedAt,
        "Provider has no filed financials for this symbol.",
      );
    }

    return {
      data: normalized.fundamentals,
      sourceId: POLYGON_SOURCE_ID,
      retrievedAt,
      dataTimestamp: normalized.dataTimestamp,
      missingFields: normalized.fundamentals.missingFields,
    };
  }

  async fetchEarnings(symbol: string, ctx?: FetchContext): Promise<ProviderResult<EarningsInfo>> {
    const s = normalizeSymbol(symbol);
    const { data, retrievedAt } = await this.#get<PolygonFinancials>(
      `/vX/reference/financials?ticker=${encodeURIComponent(s)}&limit=1&sort=period_of_report_date&order=desc`,
      ctx,
      `fundamentals:${s}`,
    );

    const earnings = normalizeEarnings(data, {
      symbol: s,
      assetId: `stock:${s}`,
      provenance: this.#provenance(retrievedAt),
    });

    if (!earnings) {
      return emptyResult<EarningsInfo>(
        POLYGON_SOURCE_ID,
        retrievedAt,
        "Provider has no earnings record for this symbol.",
      );
    }

    return {
      data: earnings,
      sourceId: POLYGON_SOURCE_ID,
      retrievedAt,
      dataTimestamp: earnings.reportDate,
      // Polygon reports filed actuals only; forward estimates need another source.
      missingFields: ["epsEstimate", "revenueEstimate"],
    };
  }

  async fetchNews(symbol: string, opts: NewsRequest, ctx?: FetchContext): Promise<ProviderResult<NewsItem[]>> {
    const s = normalizeSymbol(symbol);
    const limit = Math.max(1, Math.min(opts.limit, 50));
    const { data, retrievedAt } = await this.#get<PolygonNews>(
      `/v2/reference/news?ticker=${encodeURIComponent(s)}&limit=${limit}&order=desc&sort=published_utc`,
      ctx,
      `news:${s}:${limit}`,
    );

    const items = normalizeNews(data, {
      assetId: `stock:${s}`,
      symbol: s,
      retrievedAt,
      provenance: this.#provenance(retrievedAt),
    });

    return {
      data: items,
      sourceId: POLYGON_SOURCE_ID,
      retrievedAt,
      dataTimestamp: items[0]?.publishedAt ?? null,
      missingFields: items.length ? [] : ["news"],
    };
  }
}

export { POLYGON_SOURCE_ID };
export { ProviderError };
