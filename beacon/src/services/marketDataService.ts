import type { BeaconStore } from "../repositories/store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SourceRegistryService } from "./sourceRegistryService.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";
import { classifyFreshness } from "../lib/freshness.js";
import { isProviderError } from "../lib/errors.js";
import { normalizeSymbol } from "../lib/symbol.js";
import { buildAssetId, type Asset } from "../types/asset.js";
import type { MarketSnapshot } from "../types/marketSnapshot.js";
import type { HistoricalPrice } from "../types/historicalPrice.js";
import { deriveRangeStats } from "../normalizers/polygonNormalizer.js";
import { emptySectionStatus, type SectionStatus } from "../types/dataPackage.js";

/**
 * Retrieval + persistence for prices.
 *
 * Every method returns data alongside a SectionStatus. A provider failure
 * produces a status with `ok: false` and an honest error string — never a
 * substituted or last-known value dressed up as current.
 */

export interface MarketDataServiceOptions {
  store: BeaconStore;
  registry: ProviderRegistry;
  sources: SourceRegistryService;
  staleAfterMs: number;
  logger?: Logger;
}

export interface SectionResult<T> {
  data: T | null;
  status: SectionStatus;
}

export class MarketDataService {
  readonly #store: BeaconStore;
  readonly #registry: ProviderRegistry;
  readonly #sources: SourceRegistryService;
  readonly #staleAfterMs: number;
  readonly #logger: Logger;

  constructor(opts: MarketDataServiceOptions) {
    this.#store = opts.store;
    this.#registry = opts.registry;
    this.#sources = opts.sources;
    this.#staleAfterMs = opts.staleAfterMs;
    this.#logger = (opts.logger ?? silentLogger()).child({ service: "marketData" });
  }

  /**
   * Fetches a snapshot, enriches it with derived 52-week range and average
   * volume from stored bars, and appends it to history.
   */
  async refreshSnapshot(
    symbolRaw: string,
    asset: Asset | null,
    opts: { bypassCache?: boolean } = {},
  ): Promise<SectionResult<MarketSnapshot>> {
    const symbol = normalizeSymbol(symbolRaw);
    const provider = this.#registry.forCategory("market_price");
    if (!provider?.fetchMarketSnapshot) {
      return { data: null, status: emptySectionStatus("No registered provider serves market prices.") };
    }

    const sourceId = provider.descriptor.sourceId;

    try {
      const result = await provider.fetchMarketSnapshot(symbol, { bypassCache: opts.bypassCache });

      if (!result.data) {
        await this.#sources.recordSuccess(sourceId, result.retrievedAt);
        return {
          data: null,
          status: {
            ...emptySectionStatus(result.note ?? "Provider returned no market data."),
            sourceId,
            providerName: provider.descriptor.providerName,
            retrievedAt: result.retrievedAt,
          },
        };
      }

      const assetId = asset?.assetId ?? buildAssetId("stock", symbol);

      // 52-week range and average volume are not in the snapshot payload. They
      // are computed from stored bars and marked "estimated" — derived from real
      // measurements, but not themselves reported by the provider.
      const bars = await this.#store.listHistoricalPrices(assetId, 260);
      const derived = deriveRangeStats(bars);

      const freshness = classifyFreshness({
        dataTimestamp: result.dataTimestamp,
        retrievedAt: result.retrievedAt,
        staleAfterMs: this.#staleAfterMs,
        // The fallback path serves the last completed session, which is by
        // definition not live.
        knownDelayed: Boolean(result.note),
      });

      const missingFields = result.data.missingFields.filter(
        (f) =>
          !(
            (f === "fiftyTwoWeekHigh" && derived.fiftyTwoWeekHigh !== null) ||
            (f === "fiftyTwoWeekLow" && derived.fiftyTwoWeekLow !== null) ||
            (f === "averageVolume" && derived.averageVolume !== null)
          ),
      );

      const snapshot: MarketSnapshot = {
        ...result.data,
        assetId,
        averageVolume: derived.averageVolume,
        fiftyTwoWeekHigh: derived.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: derived.fiftyTwoWeekLow,
        provenance: {
          ...result.data.provenance,
          freshness,
          dataTimestamp: result.dataTimestamp,
        },
        missingFields,
      };

      await this.#store.appendSnapshot(snapshot);
      await this.#sources.recordSuccess(sourceId, result.retrievedAt);

      return {
        data: snapshot,
        status: {
          ok: true,
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness,
          retrievedAt: result.retrievedAt,
          dataTimestamp: result.dataTimestamp,
          error: null,
          missingFields,
        },
      };
    } catch (e) {
      const message = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
      await this.#sources.recordFailure(sourceId, message);
      this.#logger.error("snapshot refresh failed", { symbol, sourceId, error: message });

      return {
        data: null,
        status: {
          ...emptySectionStatus(message),
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness: "failed",
        },
      };
    }
  }

  /** Fetches trailing daily bars and merges them into stored history. */
  async refreshHistorical(
    symbolRaw: string,
    asset: Asset | null,
    lookbackDays = 400,
    opts: { bypassCache?: boolean } = {},
  ): Promise<SectionResult<HistoricalPrice[]>> {
    const symbol = normalizeSymbol(symbolRaw);
    const provider = this.#registry.forCategory("historical_price");
    if (!provider?.fetchHistoricalPrices) {
      return { data: null, status: emptySectionStatus("No registered provider serves historical prices.") };
    }

    const sourceId = provider.descriptor.sourceId;

    try {
      const result = await provider.fetchHistoricalPrices(
        symbol,
        { lookbackDays },
        { bypassCache: opts.bypassCache },
      );
      const assetId = asset?.assetId ?? buildAssetId("stock", symbol);
      const bars = (result.data ?? []).map((b) => ({ ...b, assetId }));

      const written = await this.#store.upsertHistoricalPrices(bars);
      await this.#sources.recordSuccess(sourceId, result.retrievedAt);
      this.#logger.info("historical bars merged", { symbol, fetched: bars.length, written });

      const freshness = classifyFreshness({
        dataTimestamp: result.dataTimestamp,
        retrievedAt: result.retrievedAt,
        // Daily bars are inherently a day old; judge them on a daily window
        // rather than the intraday snapshot window.
        staleAfterMs: 4 * 86_400_000,
      });

      return {
        data: await this.#store.listHistoricalPrices(assetId, lookbackDays),
        status: {
          ok: bars.length > 0,
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness: bars.length ? freshness : "missing",
          retrievedAt: result.retrievedAt,
          dataTimestamp: result.dataTimestamp,
          error: bars.length ? null : (result.note ?? "Provider returned no historical bars."),
          missingFields: result.missingFields,
        },
      };
    } catch (e) {
      const message = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
      await this.#sources.recordFailure(sourceId, message);
      this.#logger.error("historical refresh failed", { symbol, sourceId, error: message });

      return {
        data: null,
        status: {
          ...emptySectionStatus(message),
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness: "failed",
        },
      };
    }
  }

  async getLatestStoredSnapshot(assetId: string): Promise<MarketSnapshot | null> {
    return this.#store.getLatestSnapshot(assetId);
  }
}
