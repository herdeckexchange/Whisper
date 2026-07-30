import type { Asset } from "../types/asset.js";
import type { MarketSnapshot } from "../types/marketSnapshot.js";
import type { HistoricalPrice } from "../types/historicalPrice.js";
import type { FundamentalSnapshot, EarningsInfo } from "../types/fundamentals.js";
import type { NewsItem } from "../types/newsItem.js";
import type { DataCategory, DataSource } from "../types/dataSource.js";

/**
 * Every external vendor implements this interface. Services depend only on it,
 * never on a concrete adapter, so swapping Polygon for another provider — or
 * running two in parallel for cross-confirmation — does not touch the rest of
 * the Brain.
 *
 * Capability methods are optional. A provider that cannot serve fundamentals
 * simply omits `fetchFundamentals`, and the service layer records the section
 * as unsupported rather than fabricating a value.
 */
export interface MarketDataProvider {
  /** Registry entry describing this provider. */
  readonly descriptor: DataSource;

  /** Categories this adapter can actually serve. */
  supports(category: DataCategory): boolean;

  fetchAssetProfile?(symbol: string, ctx?: FetchContext): Promise<ProviderResult<Asset>>;
  fetchMarketSnapshot?(symbol: string, ctx?: FetchContext): Promise<ProviderResult<MarketSnapshot>>;
  fetchHistoricalPrices?(
    symbol: string,
    opts: HistoricalRequest,
    ctx?: FetchContext,
  ): Promise<ProviderResult<HistoricalPrice[]>>;
  fetchFundamentals?(symbol: string, ctx?: FetchContext): Promise<ProviderResult<FundamentalSnapshot>>;
  fetchEarnings?(symbol: string, ctx?: FetchContext): Promise<ProviderResult<EarningsInfo>>;
  fetchNews?(symbol: string, opts: NewsRequest, ctx?: FetchContext): Promise<ProviderResult<NewsItem[]>>;
}

export interface FetchContext {
  signal?: AbortSignal;
  /** Skip the provider cache for this call (used by manual founder refresh). */
  bypassCache?: boolean;
}

export interface HistoricalRequest {
  /** Number of trailing daily bars to retrieve. */
  lookbackDays: number;
}

export interface NewsRequest {
  limit: number;
}

/**
 * Provider calls resolve rather than throw for expected data gaps, so one
 * missing section never collapses an entire data package. Genuine transport
 * failures still throw ProviderError and are caught by the service layer.
 */
export interface ProviderResult<T> {
  data: T | null;
  sourceId: string;
  retrievedAt: string;
  /** Provider's own timestamp for the data, when exposed. */
  dataTimestamp: string | null;
  /** Fields the provider did not return. */
  missingFields: string[];
  /** Set when the provider succeeded at the transport level but had no data. */
  note?: string;
}

export function emptyResult<T>(
  sourceId: string,
  retrievedAt: string,
  note: string,
  missingFields: string[] = [],
): ProviderResult<T> {
  return { data: null, sourceId, retrievedAt, dataTimestamp: null, missingFields, note };
}
