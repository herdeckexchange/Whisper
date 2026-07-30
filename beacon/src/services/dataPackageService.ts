import type { AssetService } from "./assetService.js";
import type { MarketDataService } from "./marketDataService.js";
import type { FundamentalsService } from "./fundamentalsService.js";
import type { NewsService } from "./newsService.js";
import type { SourceRegistryService } from "./sourceRegistryService.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";
import { normalizeSymbol } from "../lib/symbol.js";
import { isDegraded } from "../lib/freshness.js";
import type { DataSource } from "../types/dataSource.js";
import {
  DATA_PACKAGE_SECTIONS,
  emptySectionStatus,
  type BeaconDataPackage,
  type DataPackageSection,
  type DataPackageWarning,
  type SectionStatus,
} from "../types/dataPackage.js";

/**
 * Assembles the single structured response the future committee agents consume.
 *
 * Two properties matter most and are deliberate:
 *
 *  1. Sections are independent. Fundamentals failing must not blank out prices —
 *     a committee can reason with a partial package as long as it can see which
 *     part is missing and why.
 *  2. Nothing is ever substituted. A failed section yields null data plus an
 *     error string, never a stale value quietly presented as current.
 */
export interface DataPackageOptions {
  historicalLookbackDays?: number;
  newsLimit?: number;
  /** Skip provider caches — used by the founder panel's manual refresh. */
  bypassCache?: boolean;
}

export class DataPackageService {
  readonly #assets: AssetService;
  readonly #market: MarketDataService;
  readonly #fundamentals: FundamentalsService;
  readonly #news: NewsService;
  readonly #sources: SourceRegistryService;
  readonly #logger: Logger;

  constructor(opts: {
    assets: AssetService;
    market: MarketDataService;
    fundamentals: FundamentalsService;
    news: NewsService;
    sources: SourceRegistryService;
    logger?: Logger;
  }) {
    this.#assets = opts.assets;
    this.#market = opts.market;
    this.#fundamentals = opts.fundamentals;
    this.#news = opts.news;
    this.#sources = opts.sources;
    this.#logger = (opts.logger ?? silentLogger()).child({ service: "dataPackage" });
  }

  async build(symbolRaw: string, opts: DataPackageOptions = {}): Promise<BeaconDataPackage> {
    // Throws InvalidSymbolError before any provider or store is touched.
    const symbol = normalizeSymbol(symbolRaw);
    const generatedAt = new Date().toISOString();
    const bypassCache = opts.bypassCache ?? false;
    const lookbackDays = opts.historicalLookbackDays ?? 400;
    const newsLimit = opts.newsLimit ?? 10;

    this.#logger.info("building data package", { symbol, bypassCache });

    // Asset identity is resolved first: every other section keys off assetId.
    const assetResult = await this.#assets.resolve(symbol, { bypassCache });
    const asset = assetResult.data;

    // Historical bars are fetched before the snapshot, because the snapshot's
    // 52-week range and average volume are derived from stored bars.
    const historicalResult = await this.#market.refreshHistorical(symbol, asset, lookbackDays, {
      bypassCache,
    });

    // The remaining sections are independent, so they run concurrently. Each
    // service already converts its own failures into a SectionStatus, so one
    // rejection cannot collapse the others.
    const [snapshotResult, fundamentalsResult, newsResult, earningsResult] = await Promise.all([
      this.#market.refreshSnapshot(symbol, asset, { bypassCache }),
      this.#fundamentals.refresh(symbol, asset, { bypassCache }),
      this.#news.refresh(symbol, asset, newsLimit, { bypassCache }),
      this.#fundamentals.refreshEarnings(symbol, asset, { bypassCache }),
    ]);

    const sections: Record<DataPackageSection, SectionStatus> = {
      asset: assetResult.status,
      marketSnapshot: snapshotResult.status,
      historicalPrices: historicalResult.status,
      fundamentals: fundamentalsResult.status,
      news: newsResult.status,
      earnings: earningsResult.status,
    };

    const warnings = buildWarnings(sections);

    // Only registry rows for sources that actually contributed to this package.
    const contributingIds = [
      ...new Set(
        Object.values(sections)
          .map((s) => s.sourceId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const sources: DataSource[] = [];
    for (const id of contributingIds) {
      const s = await this.#sources.get(id);
      if (s) sources.push(s);
    }

    const complete = DATA_PACKAGE_SECTIONS.every((k) => sections[k].ok);

    return {
      symbol,
      assetId: asset?.assetId ?? null,
      generatedAt,
      asset,
      marketSnapshot: snapshotResult.data,
      historicalPrices: historicalResult.data ?? [],
      fundamentals: fundamentalsResult.data,
      earnings: earningsResult.data,
      news: newsResult.data ?? [],
      sections,
      sources,
      warnings,
      lastSuccessfulRefresh: await this.#sources.lastSuccessfulRefresh(contributingIds),
      complete,
    };
  }
}

/**
 * Turns section statuses into explicit warnings. Every degraded or absent
 * section produces a warning, so a committee never has to infer a gap from a
 * null it might not have checked.
 */
export function buildWarnings(
  sections: Record<DataPackageSection, SectionStatus>,
): DataPackageWarning[] {
  const warnings: DataPackageWarning[] = [];

  for (const section of DATA_PACKAGE_SECTIONS) {
    const status = sections[section];

    if (!status.ok) {
      warnings.push({
        section,
        code: status.freshness === "failed" ? "section_failed" : "section_unavailable",
        message:
          status.error ??
          `No data available for section "${section}" (${status.freshness}).`,
      });
      continue;
    }

    if (isDegraded(status.freshness)) {
      warnings.push({
        section,
        code: status.freshness === "stale" ? "stale_data" : "derived_data",
        message:
          status.freshness === "stale"
            ? `Section "${section}" is stale — the provider's data timestamp is older than its freshness window. Do not treat it as current.`
            : `Section "${section}" contains derived rather than directly reported values.`,
      });
    }

    if (status.freshness === "delayed") {
      warnings.push({
        section,
        code: "delayed_feed",
        message: `Section "${section}" is served on a provider delay and is not real-time.`,
      });
    }

    if (status.missingFields.length > 0) {
      warnings.push({
        section,
        code: "missing_fields",
        message: `Provider did not supply: ${status.missingFields.join(", ")}.`,
      });
    }
  }

  return warnings;
}

export { emptySectionStatus };
