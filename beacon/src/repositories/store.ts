import type { Asset } from "../types/asset.js";
import type { MarketSnapshot } from "../types/marketSnapshot.js";
import type { HistoricalPrice } from "../types/historicalPrice.js";
import type { FundamentalSnapshot } from "../types/fundamentals.js";
import type { NewsItem } from "../types/newsItem.js";
import type { DataSource } from "../types/dataSource.js";

/**
 * Storage contract for the Beacon Brain.
 *
 * Defined as an interface so the Brain is not married to one database. The
 * in-memory implementation ships here and is what the tests run against; a
 * Postgres implementation backed by `schema.sql` is the production target.
 *
 * The central rule every implementation must honour: snapshots, historical
 * bars, and fundamentals are APPEND-ONLY. Beacon has to be able to reconstruct
 * what it knew at the moment a past recommendation was made, so a refresh adds
 * a row — it never overwrites one. Only `Asset` and `DataSource`, which
 * describe present-tense identity and health, are updated in place.
 */
export interface BeaconStore {
  // --- Assets (upserted: identity, not history) ---
  upsertAsset(asset: Asset): Promise<Asset>;
  getAssetById(assetId: string): Promise<Asset | null>;
  getAssetBySymbol(symbol: string): Promise<Asset | null>;

  // --- Market snapshots (append-only) ---
  appendSnapshot(snapshot: MarketSnapshot): Promise<MarketSnapshot>;
  getLatestSnapshot(assetId: string): Promise<MarketSnapshot | null>;
  listSnapshots(assetId: string, limit?: number): Promise<MarketSnapshot[]>;
  countSnapshots(assetId: string): Promise<number>;

  // --- Historical bars (append-only, deduped on (asset, date, source)) ---
  upsertHistoricalPrices(bars: HistoricalPrice[]): Promise<number>;
  listHistoricalPrices(assetId: string, limit?: number): Promise<HistoricalPrice[]>;

  // --- Fundamentals (append-only by reporting period) ---
  appendFundamentals(f: FundamentalSnapshot): Promise<FundamentalSnapshot>;
  getLatestFundamentals(assetId: string): Promise<FundamentalSnapshot | null>;
  listFundamentals(assetId: string, limit?: number): Promise<FundamentalSnapshot[]>;

  // --- News (deduped by article ID and duplicate group) ---
  upsertNews(items: NewsItem[]): Promise<NewsItem[]>;
  listNews(assetId: string, limit?: number): Promise<NewsItem[]>;

  // --- Source registry ---
  upsertSource(source: DataSource): Promise<DataSource>;
  getSource(sourceId: string): Promise<DataSource | null>;
  listSources(): Promise<DataSource[]>;

  // --- Job runs (failed-job recording) ---
  recordJobRun(run: JobRun): Promise<JobRun>;
  listJobRuns(limit?: number): Promise<JobRun[]>;
}

export interface JobRun {
  jobRunId: string;
  jobName: string;
  startedAt: string;
  finishedAt: string | null;
  status: "success" | "partial" | "failed";
  symbolsProcessed: string[];
  errors: Array<{ symbol: string | null; message: string; code?: string }>;
  durationMs: number | null;
}
