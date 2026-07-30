import type { Asset } from "../types/asset.js";
import type { MarketSnapshot } from "../types/marketSnapshot.js";
import { historicalKey, type HistoricalPrice } from "../types/historicalPrice.js";
import type { FundamentalSnapshot } from "../types/fundamentals.js";
import { headlineFingerprint, type NewsItem } from "../types/newsItem.js";
import type { DataSource } from "../types/dataSource.js";
import type { BeaconStore, JobRun } from "./store.js";

/**
 * In-memory BeaconStore.
 *
 * This is the reference implementation of the storage contract and what the
 * test suite exercises. It enforces the same append-only guarantees the
 * Postgres implementation must, so a behavioural regression shows up in tests
 * rather than in production history.
 *
 * Not suitable for production on its own: state is lost on restart, and Replit
 * containers restart routinely. See schema.sql and README for the Postgres path.
 */
export class MemoryStore implements BeaconStore {
  readonly #assets = new Map<string, Asset>();
  readonly #snapshots = new Map<string, MarketSnapshot[]>();
  readonly #historical = new Map<string, HistoricalPrice>();
  readonly #fundamentals = new Map<string, FundamentalSnapshot[]>();
  readonly #news = new Map<string, NewsItem>();
  /** headline fingerprint -> duplicateGroupId, for cross-publisher dedup. */
  readonly #newsGroups = new Map<string, string>();
  readonly #sources = new Map<string, DataSource>();
  readonly #jobRuns: JobRun[] = [];

  // --- Assets -------------------------------------------------------------

  async upsertAsset(asset: Asset): Promise<Asset> {
    const existing = this.#assets.get(asset.assetId);
    const merged: Asset = existing
      ? { ...existing, ...asset, createdAt: existing.createdAt, updatedAt: asset.updatedAt }
      : { ...asset };
    this.#assets.set(merged.assetId, merged);
    return { ...merged };
  }

  async getAssetById(assetId: string): Promise<Asset | null> {
    const a = this.#assets.get(assetId);
    return a ? { ...a } : null;
  }

  async getAssetBySymbol(symbol: string): Promise<Asset | null> {
    const upper = symbol.toUpperCase();
    for (const a of this.#assets.values()) {
      if (a.symbol.toUpperCase() === upper) return { ...a };
    }
    return null;
  }

  // --- Snapshots (append-only) --------------------------------------------

  async appendSnapshot(snapshot: MarketSnapshot): Promise<MarketSnapshot> {
    const list = this.#snapshots.get(snapshot.assetId) ?? [];
    // Every refresh is a new row. Nothing is replaced, so the full sequence of
    // what Beacon observed remains reconstructable.
    list.push({ ...snapshot });
    this.#snapshots.set(snapshot.assetId, list);
    return { ...snapshot };
  }

  async getLatestSnapshot(assetId: string): Promise<MarketSnapshot | null> {
    const list = this.#snapshots.get(assetId);
    if (!list?.length) return null;
    // Ordered by retrieval time rather than array position, so an out-of-order
    // backfill cannot masquerade as the newest reading.
    const latest = list.reduce((best, s) =>
      Date.parse(s.provenance.retrievedAt) >= Date.parse(best.provenance.retrievedAt) ? s : best,
    );
    return { ...latest };
  }

  async listSnapshots(assetId: string, limit = 100): Promise<MarketSnapshot[]> {
    const list = this.#snapshots.get(assetId) ?? [];
    return [...list]
      .sort((a, b) => Date.parse(b.provenance.retrievedAt) - Date.parse(a.provenance.retrievedAt))
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  async countSnapshots(assetId: string): Promise<number> {
    return this.#snapshots.get(assetId)?.length ?? 0;
  }

  // --- Historical bars ----------------------------------------------------

  async upsertHistoricalPrices(bars: HistoricalPrice[]): Promise<number> {
    let written = 0;
    for (const bar of bars) {
      const key = historicalKey(bar);
      const existing = this.#historical.get(key);
      // A bar for a given (asset, date, source) is immutable history. Re-fetching
      // the same day must not churn it; only genuinely new days are written.
      if (existing) continue;
      this.#historical.set(key, { ...bar });
      written++;
    }
    return written;
  }

  async listHistoricalPrices(assetId: string, limit = 400): Promise<HistoricalPrice[]> {
    return [...this.#historical.values()]
      .filter((b) => b.assetId === assetId)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-limit)
      .map((b) => ({ ...b }));
  }

  // --- Fundamentals -------------------------------------------------------

  async appendFundamentals(f: FundamentalSnapshot): Promise<FundamentalSnapshot> {
    const list = this.#fundamentals.get(f.assetId) ?? [];
    // Restatements append a new row for the same period rather than editing the
    // old one, so Beacon can see that a figure changed and when.
    list.push({ ...f });
    this.#fundamentals.set(f.assetId, list);
    return { ...f };
  }

  async getLatestFundamentals(assetId: string): Promise<FundamentalSnapshot | null> {
    const list = this.#fundamentals.get(assetId);
    if (!list?.length) return null;
    const latest = list.reduce((best, f) =>
      Date.parse(f.provenance.retrievedAt) >= Date.parse(best.provenance.retrievedAt) ? f : best,
    );
    return { ...latest };
  }

  async listFundamentals(assetId: string, limit = 20): Promise<FundamentalSnapshot[]> {
    const list = this.#fundamentals.get(assetId) ?? [];
    return [...list]
      .sort((a, b) => Date.parse(b.provenance.retrievedAt) - Date.parse(a.provenance.retrievedAt))
      .slice(0, limit)
      .map((f) => ({ ...f }));
  }

  // --- News ---------------------------------------------------------------

  async upsertNews(items: NewsItem[]): Promise<NewsItem[]> {
    const out: NewsItem[] = [];
    for (const item of items) {
      // Same wire story syndicated across outlets collapses into one group; the
      // first article seen becomes the group representative.
      const fingerprint = headlineFingerprint(item.headline);
      let groupId = this.#newsGroups.get(fingerprint);
      if (!groupId) {
        groupId = item.articleId;
        this.#newsGroups.set(fingerprint, groupId);
      }

      const existing = this.#news.get(item.articleId);
      const stored: NewsItem = {
        ...item,
        duplicateGroupId: groupId,
        // Never regress a corroborated article back to unverified on re-ingest.
        verificationStatus: existing?.verificationStatus === "corroborated"
          ? "corroborated"
          : item.verificationStatus,
      };
      this.#news.set(stored.articleId, stored);
      out.push({ ...stored });
    }
    return out;
  }

  async listNews(assetId: string, limit = 25): Promise<NewsItem[]> {
    return [...this.#news.values()]
      .filter((n) => n.relatedAssetIds.includes(assetId))
      .sort((a, b) => Date.parse(b.publishedAt ?? "0") - Date.parse(a.publishedAt ?? "0"))
      .slice(0, limit)
      .map((n) => ({ ...n }));
  }

  // --- Source registry ----------------------------------------------------

  async upsertSource(source: DataSource): Promise<DataSource> {
    this.#sources.set(source.sourceId, { ...source });
    return { ...source };
  }

  async getSource(sourceId: string): Promise<DataSource | null> {
    const s = this.#sources.get(sourceId);
    return s ? { ...s } : null;
  }

  async listSources(): Promise<DataSource[]> {
    return [...this.#sources.values()].map((s) => ({ ...s }));
  }

  // --- Job runs -----------------------------------------------------------

  async recordJobRun(run: JobRun): Promise<JobRun> {
    this.#jobRuns.push({ ...run });
    // Bounded so a long-lived container does not accumulate runs indefinitely.
    if (this.#jobRuns.length > 500) this.#jobRuns.splice(0, this.#jobRuns.length - 500);
    return { ...run };
  }

  async listJobRuns(limit = 50): Promise<JobRun[]> {
    return [...this.#jobRuns]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
