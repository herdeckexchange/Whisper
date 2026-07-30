import type { BeaconStore } from "../repositories/store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SourceRegistryService } from "./sourceRegistryService.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";
import { isProviderError } from "../lib/errors.js";
import { normalizeSymbol } from "../lib/symbol.js";
import type { Asset } from "../types/asset.js";
import { emptySectionStatus } from "../types/dataPackage.js";
import type { SectionResult } from "./marketDataService.js";

/**
 * Resolves a symbol to Beacon's canonical Asset record.
 *
 * Asset identity is upserted rather than appended: it describes what the
 * instrument *is* right now. The historical record of prices and fundamentals
 * carries the time dimension instead.
 */
export class AssetService {
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
    this.#logger = (opts.logger ?? silentLogger()).child({ service: "asset" });
  }

  async resolve(symbolRaw: string, opts: { bypassCache?: boolean } = {}): Promise<SectionResult<Asset>> {
    const symbol = normalizeSymbol(symbolRaw);
    const provider = this.#registry.forCategory("market_price");

    if (!provider?.fetchAssetProfile) {
      // Fall back to whatever identity is already stored rather than failing —
      // a known asset with no fresh profile is still usable downstream.
      const stored = await this.#store.getAssetBySymbol(symbol);
      return {
        data: stored,
        status: stored
          ? { ...emptySectionStatus(), ok: true, freshness: "stale" }
          : emptySectionStatus("No registered provider serves asset profiles."),
      };
    }

    const sourceId = provider.descriptor.sourceId;

    try {
      const result = await provider.fetchAssetProfile(symbol, { bypassCache: opts.bypassCache });

      if (!result.data) {
        await this.#sources.recordSuccess(sourceId, result.retrievedAt);
        const stored = await this.#store.getAssetBySymbol(symbol);
        return {
          data: stored,
          status: {
            ...emptySectionStatus(result.note ?? `Provider has no profile for ${symbol}.`),
            sourceId,
            providerName: provider.descriptor.providerName,
            retrievedAt: result.retrievedAt,
          },
        };
      }

      const saved = await this.#store.upsertAsset(result.data);
      await this.#sources.recordSuccess(sourceId, result.retrievedAt);

      return {
        data: saved,
        status: {
          ok: true,
          sourceId,
          providerName: provider.descriptor.providerName,
          // Reference data changes rarely; a successful fetch is current.
          freshness: "fresh",
          retrievedAt: result.retrievedAt,
          dataTimestamp: result.dataTimestamp,
          error: null,
          missingFields: result.missingFields,
        },
      };
    } catch (e) {
      const message = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
      await this.#sources.recordFailure(sourceId, message);
      this.#logger.error("asset resolve failed", { symbol, sourceId, error: message });

      // Degrade to stored identity so a profile outage does not blank the package.
      const stored = await this.#store.getAssetBySymbol(symbol);
      return {
        data: stored,
        status: {
          ...emptySectionStatus(message),
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness: stored ? "stale" : "failed",
        },
      };
    }
  }
}
