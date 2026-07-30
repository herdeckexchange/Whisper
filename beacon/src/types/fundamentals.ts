import type { Provenance } from "./provenance.js";

/**
 * Fundamentals arrive per reporting period. Stored append-only by period so a
 * restatement does not erase what Beacon believed at an earlier date.
 */
export interface FundamentalSnapshot {
  fundamentalId: string;
  assetId: string;
  symbol: string;

  revenue: number | null;
  earnings: number | null;
  eps: number | null;
  profitMargin: number | null;
  cash: number | null;
  debt: number | null;

  /** Valuation metrics are optional across providers; absent stays null, never 0. */
  valuation: {
    peRatio: number | null;
    priceToSales: number | null;
    priceToBook: number | null;
    enterpriseValue: number | null;
  };

  /** e.g. "2024Q3" or "2024FY". */
  reportingPeriod: string | null;
  fiscalPeriodEnd: string | null;

  provenance: Provenance;
  missingFields: string[];
}

/** Next scheduled earnings event, when the provider exposes one. */
export interface EarningsInfo {
  assetId: string;
  symbol: string;
  reportDate: string | null;
  period: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  provenance: Provenance;
}
