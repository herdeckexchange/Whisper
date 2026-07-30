/**
 * The source registry is what lets Beacon reason about its own inputs: which
 * provider supplied a field, how much to trust it, and whether it is currently
 * healthy. Later sprints add social/narrative sources to this same registry.
 */

export const DATA_CATEGORIES = [
  "market_price",
  "historical_price",
  "fundamentals",
  "news",
  "earnings",
  "macro",
  "sec_filings",
  "insider_activity",
  "institutional_holdings",
  "options",
  "crypto",
  "social_narrative",
] as const;

export type DataCategory = (typeof DATA_CATEGORIES)[number];

export const PROVIDER_TYPES = ["official", "third_party", "aggregator", "derived"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * Reliability tiers feed the future Learning Engine. Tier 1 is an authoritative
 * primary source (an exchange, or the SEC); tier 4 is unvetted commentary.
 */
export const RELIABILITY_TIERS = [1, 2, 3, 4] as const;
export type ReliabilityTier = (typeof RELIABILITY_TIERS)[number];

export const HEALTH_STATUSES = ["healthy", "degraded", "failing", "unknown"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface DataSource {
  sourceId: string;
  providerName: string;
  categories: DataCategory[];
  providerType: ProviderType;
  /** True when the provider is the authoritative originator of the data. */
  official: boolean;
  reliabilityTier: ReliabilityTier;
  /** Nominal refresh cadence in milliseconds for this source's data. */
  refreshFrequencyMs: number;
  lastSuccessfulRefresh: string | null;
  lastFailedRefresh: string | null;
  lastFailureReason: string | null;
  healthStatus: HealthStatus;
  /** Licence/attribution obligations that must travel with the data. */
  licensingNotes: string | null;
  attribution: string | null;
  /** Source to fall back to when this one is failing. */
  backupSourceId: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

/**
 * Health is derived from consecutive failures rather than a single blip, so a
 * lone timeout does not flip a provider to "failing" and trigger failover.
 */
export function deriveHealth(consecutiveFailures: number): HealthStatus {
  if (consecutiveFailures === 0) return "healthy";
  if (consecutiveFailures < 3) return "degraded";
  return "failing";
}
