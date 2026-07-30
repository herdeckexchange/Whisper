import type { BeaconStore } from "../repositories/store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SourceRegistryService } from "./sourceRegistryService.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";
import { isProviderError } from "../lib/errors.js";
import { normalizeSymbol } from "../lib/symbol.js";
import { classifyFreshness } from "../lib/freshness.js";
import { buildAssetId, type Asset } from "../types/asset.js";
import type { NewsItem } from "../types/newsItem.js";
import { emptySectionStatus } from "../types/dataPackage.js";
import type { SectionResult } from "./marketDataService.js";

/** News goes stale fast; a day-old headline is no longer "current" for Beacon. */
const NEWS_STALE_AFTER_MS = 24 * 3_600_000;

/**
 * News retrieval and de-duplication.
 *
 * De-duplication matters more here than elsewhere: the same wire story
 * syndicated across a dozen outlets would otherwise look like a surge of
 * independent coverage, which is exactly the signal Beacon's future
 * promotion/pump analysis must not be fooled by.
 */
export class NewsService {
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
    this.#logger = (opts.logger ?? silentLogger()).child({ service: "news" });
  }

  async refresh(
    symbolRaw: string,
    asset: Asset | null,
    limit = 10,
    opts: { bypassCache?: boolean } = {},
  ): Promise<SectionResult<NewsItem[]>> {
    const symbol = normalizeSymbol(symbolRaw);
    const provider = this.#registry.forCategory("news");
    if (!provider?.fetchNews) {
      return { data: null, status: emptySectionStatus("No registered provider serves news.") };
    }

    const sourceId = provider.descriptor.sourceId;

    try {
      const result = await provider.fetchNews(symbol, { limit }, { bypassCache: opts.bypassCache });
      const assetId = asset?.assetId ?? buildAssetId("stock", symbol);
      const items = (result.data ?? []).map((n) => ({ ...n, relatedAssetIds: [assetId] }));

      // The store assigns duplicate groups; returning its output means callers
      // see the grouped view rather than the raw provider list.
      const stored = await this.#store.upsertNews(items);
      await this.#sources.recordSuccess(sourceId, result.retrievedAt);

      const freshness = classifyFreshness({
        dataTimestamp: result.dataTimestamp,
        retrievedAt: result.retrievedAt,
        staleAfterMs: NEWS_STALE_AFTER_MS,
      });

      const deduped = dedupeByGroup(stored);
      this.#logger.info("news refreshed", {
        symbol,
        fetched: items.length,
        afterDedup: deduped.length,
      });

      return {
        data: deduped,
        status: {
          ok: items.length > 0,
          sourceId,
          providerName: provider.descriptor.providerName,
          freshness: items.length ? freshness : "missing",
          retrievedAt: result.retrievedAt,
          dataTimestamp: result.dataTimestamp,
          error: items.length ? null : `No recent news available for ${symbol}.`,
          missingFields: result.missingFields,
        },
      };
    } catch (e) {
      const message = isProviderError(e) ? e.message : e instanceof Error ? e.message : String(e);
      await this.#sources.recordFailure(sourceId, message);
      this.#logger.error("news refresh failed", { symbol, sourceId, error: message });
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

/**
 * Collapses each duplicate group to its earliest-published representative, so
 * a syndicated story counts once. Ordering is newest-first.
 */
export function dedupeByGroup(items: NewsItem[]): NewsItem[] {
  const byGroup = new Map<string, NewsItem>();

  for (const item of items) {
    const key = item.duplicateGroupId ?? item.articleId;
    const existing = byGroup.get(key);
    if (!existing) {
      byGroup.set(key, item);
      continue;
    }
    // Prefer the earliest publication — the original, not the syndication.
    const a = Date.parse(item.publishedAt ?? "");
    const b = Date.parse(existing.publishedAt ?? "");
    if (Number.isFinite(a) && (!Number.isFinite(b) || a < b)) {
      byGroup.set(key, item);
    }
  }

  return [...byGroup.values()].sort(
    (a, b) => Date.parse(b.publishedAt ?? "0") - Date.parse(a.publishedAt ?? "0"),
  );
}
