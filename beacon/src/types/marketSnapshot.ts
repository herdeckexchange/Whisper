import type { Provenance } from "./provenance.js";

/**
 * A point-in-time market reading. Snapshots are stored append-only: each
 * refresh writes a new row rather than overwriting the last one, so Beacon can
 * later reconstruct exactly what it knew at the moment a recommendation was made.
 */
export interface MarketSnapshot {
  snapshotId: string;
  assetId: string;
  symbol: string;

  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  averageVolume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;

  /** When the market data itself was measured, per the provider. */
  marketTimestamp: string | null;
  provenance: Provenance;

  /** Field names the provider did not supply, surfaced to callers verbatim. */
  missingFields: string[];
}

/**
 * Change and percent change are derived only when both inputs are genuinely
 * present. Beacon does not invent a zero when previous close is unknown.
 */
export function deriveChange(
  price: number | null,
  previousClose: number | null,
): { change: number | null; changePercent: number | null } {
  if (
    price === null ||
    previousClose === null ||
    !Number.isFinite(price) ||
    !Number.isFinite(previousClose) ||
    previousClose === 0
  ) {
    return { change: null, changePercent: null };
  }
  const change = price - previousClose;
  return {
    change: round(change, 4),
    changePercent: round((change / previousClose) * 100, 4),
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
