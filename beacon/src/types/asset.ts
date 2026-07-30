/**
 * Asset is Beacon's universal identity record. It intentionally covers every
 * class Beacon must eventually analyse — not just large-cap US equities — so
 * that crypto/options/ETF connectors slot in without a schema migration.
 */

export const ASSET_TYPES = [
  "stock",
  "etf",
  "crypto",
  "option",
  "index",
  "fund",
  "adr",
  "warrant",
  "other",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * Cap tiers exist so Beacon can be explicitly steered toward the whole market.
 * Screening by tier is a later sprint; carrying the field now keeps the door open.
 */
export const CAP_TIERS = ["mega", "large", "mid", "small", "micro", "nano", "unknown"] as const;
export type CapTier = (typeof CAP_TIERS)[number];

export interface Asset {
  /** Beacon-internal stable ID, independent of any provider's identifier. */
  assetId: string;
  symbol: string;
  name: string | null;
  assetType: AssetType;
  exchange: string | null;
  currency: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  capTier: CapTier;
  active: boolean;
  /** Provider-specific IDs keyed by sourceId, for reconciliation across vendors. */
  externalIds?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** Market-cap boundaries in USD. Deliberately inclusive of micro/nano tiers. */
export function classifyCapTier(marketCap: number | null): CapTier {
  if (marketCap === null || !Number.isFinite(marketCap) || marketCap <= 0) return "unknown";
  if (marketCap >= 200e9) return "mega";
  if (marketCap >= 10e9) return "large";
  if (marketCap >= 2e9) return "mid";
  if (marketCap >= 300e6) return "small";
  if (marketCap >= 50e6) return "micro";
  return "nano";
}

/**
 * Beacon-internal asset ID. Deterministic so repeated ingestion of the same
 * instrument converges on one record instead of creating duplicates.
 */
export function buildAssetId(assetType: AssetType, symbol: string): string {
  return `${assetType}:${symbol.trim().toUpperCase()}`;
}
