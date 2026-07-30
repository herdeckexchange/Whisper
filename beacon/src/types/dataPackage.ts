import type { Asset } from "./asset.js";
import type { MarketSnapshot } from "./marketSnapshot.js";
import type { HistoricalPrice } from "./historicalPrice.js";
import type { FundamentalSnapshot, EarningsInfo } from "./fundamentals.js";
import type { NewsItem } from "./newsItem.js";
import type { DataSource } from "./dataSource.js";
import type { FreshnessStatus } from "./provenance.js";

/**
 * The single structured response the future committee agents consume. Each
 * section reports its own provider and freshness independently, because a
 * package with live prices but a failed fundamentals call is still useful —
 * as long as the committee can see exactly which half it can trust.
 */

export interface SectionStatus {
  /** Did this section retrieve usable data? */
  ok: boolean;
  sourceId: string | null;
  providerName: string | null;
  freshness: FreshnessStatus;
  retrievedAt: string | null;
  dataTimestamp: string | null;
  /** Present only when ok === false. Never a fabricated fallback value. */
  error: string | null;
  missingFields: string[];
}

export interface DataPackageWarning {
  section: DataPackageSection;
  code: string;
  message: string;
}

export const DATA_PACKAGE_SECTIONS = [
  "asset",
  "marketSnapshot",
  "historicalPrices",
  "fundamentals",
  "news",
  "earnings",
] as const;

export type DataPackageSection = (typeof DATA_PACKAGE_SECTIONS)[number];

export interface BeaconDataPackage {
  symbol: string;
  assetId: string | null;
  /** When Beacon assembled this package. */
  generatedAt: string;

  asset: Asset | null;
  marketSnapshot: MarketSnapshot | null;
  historicalPrices: HistoricalPrice[];
  fundamentals: FundamentalSnapshot | null;
  earnings: EarningsInfo | null;
  news: NewsItem[];

  /** Per-section provider + freshness metadata. */
  sections: Record<DataPackageSection, SectionStatus>;

  /** Registry entries for every source that contributed to this package. */
  sources: DataSource[];

  /** Human-readable warnings: missing fields, provider errors, staleness. */
  warnings: DataPackageWarning[];

  /** Most recent successful refresh across all contributing sources. */
  lastSuccessfulRefresh: string | null;

  /**
   * True only when every section succeeded. Committees should treat a partial
   * package as lower-confidence input rather than silently proceeding.
   */
  complete: boolean;
}

export function emptySectionStatus(error: string | null = null): SectionStatus {
  return {
    ok: false,
    sourceId: null,
    providerName: null,
    freshness: error ? "failed" : "missing",
    retrievedAt: null,
    dataTimestamp: null,
    error,
    missingFields: [],
  };
}
