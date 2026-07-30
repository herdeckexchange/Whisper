import type { BeaconStore } from "../repositories/store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SourceRegistryService } from "./sourceRegistryService.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";
import { isProviderError } from "../lib/errors.js";
import { normalizeSymbol } from "../lib/symbol.js";
import { classifyFreshness } from "../lib/freshness.js";
import { buildAssetId, type Asset } from "../types/asset.js";
import type { FundamentalSnapshot, EarningsInfo } from "../types/fundamentals.js";
import { emptySectionStatus } from "../types/dataPackage.js";
import type { SectionResult } from "./marketDataService.js";

/** Fundamentals move on filing cadence, so a quarter-old figure is still current. */
const FUNDAMENTALS_STALE_AFTER_MS = 120 * 86_400_000;

export class FundamentalsService {
  readonly #store: BeaconStore;
  readonly #registry: ProviderRegistry;
  readonly #sources: SourceRegistryService;
  readonly #logger: Logger;

  constructor(opts: {
    store: BeaconStore;
    registry: ProviderRegistry;
    sources: SourceRegistryService;
    logger?: Logger;
  }) {
    this.#store = opts.store;
    this.#registry = opts.registry;
    this.#sources = opts.sources;
    this.#logger = (opts.logger ?? silentLogger()).child({ service: "fundamentals" });
  }

  async refresh(
    symbolRaw: string,
    asset: Asset | null,
    opts: { bypassCache?: boolean } = {},
  ): Promise<SectionResult<FundamentalSnapshot>> {
    const symbol = normalizeSymbol(symbolRaw);
    const provider = this.#registry.forCategory("fundamentals");
    if (!provider?.fetchFundamentals) {
      return { data: null, status: emptySectionStatus("No registered provider serves fundamentals.") };
    }

    const sourceId = provider.descriptor.sourceId;

    try {
      const result = await provider.fetchFundamentals(symbol, { bypassCache: opts.bypassCache });

      if (!result.data) {
        await this.#sources.recordSuccess(sourceId, result.retrievedAt);
        return {
          data: null,
          status: {
            ...emptySectionStatus(result.note ?? `No filed financials available for ${symbol}.`),
            sourceId,
            providerName: provider.descriptor.providerName,
            retrievedAt: result.retrievedAt,
          },
        };
      }

      const assetId = asset?.assetId ?? buildAssetId("stock", symbol);
      const freshness = classifyFreshness({
        dataTimestamp: result.dataTimestamp,
        retrievedAt: result.retrievedAt,
        staleAfterMs: FUNDAMENTALS_STALE_AFTER_MS,
      });

      const record: FundamentalSnapshot = {
        ...result.data,
        assetId,
        provenance: { ...result.data.provenance, freshness, dataTimestamp: result.dataTimestamp },
      };

      await this.#store.appendFundamentals(record);
      await this.#sources.recordSuccess(sourceId, result.retrievedAt);

      return {
        data: record,
        status: {
          ok: true,
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness,
          retrievedAt: result.retrievedAt,
          dataTimestamp: result.dataTimestamp,
          error: null,
          missingFields: record.missingFields,
        },
      };
    } catch (e) {
      const message = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
      await this.#sources.recordFailure(sourceId, message);
      this.#logger.error("fundamentals refresh failed", { symbol, sourceId, error: message });
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

  async refreshEarnings(
    symbolRaw: string,
    asset: Asset | null,
    opts: { bypassCache?: boolean } = {},
  ): Promise<SectionResult<EarningsInfo>> {
    const symbol = normalizeSymbol(symbolRaw);
    const provider = this.#registry.forCategory("earnings");
    if (!provider?.fetchEarnings) {
      return { data: null, status: emptySectionStatus("No registered provider serves earnings.") };
    }

    const sourceId = provider.descriptor.sourceId;

    try {
      const result = await provider.fetchEarnings(symbol, { bypassCache: opts.bypassCache });
      if (!result.data) {
        return {
          data: null,
          status: {
            ...emptySectionStatus(result.note ?? `No earnings record available for ${symbol}.`),
            sourceId,
            providerName: provider.descriptor.providerName,
            retrievedAt: result.retrievedAt,
          },
        };
      }

      const assetId = asset?.assetId ?? buildAssetId("stock", symbol);
      const freshness = classifyFreshness({
        dataTimestamp: result.dataTimestamp,
        retrievedAt: result.retrievedAt,
        staleAfterMs: FUNDAMENTALS_STALE_AFTER_MS,
      });

      return {
        data: { ...result.data, assetId, provenance: { ...result.data.provenance, freshness } },
        status: {
          ok: true,
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness,
          retrievedAt: result.retrievedAt,
          dataTimestamp: result.dataTimestamp,
          error: null,
          missingFields: result.missingFields,
        },
      };
    } catch (e) {
      const message = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
      await this.#sources.recordFailure(sourceId, message);
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
}
