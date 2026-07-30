/** One OHLCV bar. Keyed by (assetId, date, sourceId) so two providers can coexist. */
export interface HistoricalPrice {
  assetId: string;
  symbol: string;
  /** ISO date (YYYY-MM-DD) for daily bars, full ISO timestamp for intraday. */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** Split/dividend adjusted close where the provider supplies it. */
  adjustedClose: number | null;
  volume: number | null;
  sourceId: string;
  retrievedAt: string;
}

export function historicalKey(p: Pick<HistoricalPrice, "assetId" | "date" | "sourceId">): string {
  return `${p.assetId}|${p.date}|${p.sourceId}`;
}
