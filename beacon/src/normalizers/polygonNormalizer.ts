import { buildAssetId, classifyCapTier, type Asset, type AssetType } from "../types/asset.js";
import { deriveChange, type MarketSnapshot } from "../types/marketSnapshot.js";
import type { HistoricalPrice } from "../types/historicalPrice.js";
import type { FundamentalSnapshot, EarningsInfo } from "../types/fundamentals.js";
import { headlineFingerprint, type NewsItem } from "../types/newsItem.js";
import type { Provenance } from "../types/provenance.js";

/**
 * Translates Polygon's REST payloads into Beacon's internal schemas.
 *
 * All of Polygon's idiosyncrasies are contained here — nanosecond timestamps,
 * zero-filled OHLC before the open, `results` vs `ticker` envelopes — so that
 * nothing downstream has to know which vendor produced a record.
 */

export const POLYGON_SOURCE_ID = "polygon.io";

// ---------------------------------------------------------------------------
// Primitive coercion
// ---------------------------------------------------------------------------

/**
 * Polygon zero-fills OHLC fields before the session opens. A traded instrument
 * cannot have a price of 0, so a 0 here means "not reported yet", not "worth
 * nothing" — collapsing it to null keeps Beacon from publishing a fake $0 price.
 */
function positiveOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** Volume legitimately can be 0, so it only rejects non-finite/negative values. */
function nonNegativeOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function stringOrNull(s: unknown): string | null {
  return typeof s === "string" && s.trim() !== "" ? s.trim() : null;
}

/** Polygon mixes nanosecond and millisecond epochs across endpoints. */
export function nanosToIso(ns: unknown): string | null {
  if (typeof ns !== "number" || !Number.isFinite(ns) || ns <= 0) return null;
  return msToIso(Math.floor(ns / 1_000_000));
}

export function msToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Polygon's instrument taxonomy mapped onto Beacon's asset types. */
export function mapAssetType(polygonType: unknown, market?: unknown): AssetType {
  const t = typeof polygonType === "string" ? polygonType.toUpperCase() : "";
  switch (t) {
    case "CS":
    case "PFD":
    case "OS":
    case "UNIT":
      return "stock";
    case "ETF":
    case "ETV":
    case "ETN":
    case "ETS":
      return "etf";
    case "ADRC":
    case "ADRP":
    case "ADRR":
      return "adr";
    case "FUND":
      return "fund";
    case "INDEX":
      return "index";
    case "WARRANT":
      return "warrant";
    default:
      break;
  }
  const m = typeof market === "string" ? market.toLowerCase() : "";
  if (m === "crypto") return "crypto";
  if (m === "options") return "option";
  if (m === "indices") return "index";
  if (m === "stocks") return "stock";
  return "other";
}

// ---------------------------------------------------------------------------
// Asset profile  (GET /v3/reference/tickers/{ticker})
// ---------------------------------------------------------------------------

export interface PolygonTickerDetails {
  results?: {
    ticker?: string;
    name?: string;
    market?: string;
    locale?: string;
    primary_exchange?: string;
    type?: string;
    active?: boolean;
    currency_name?: string;
    market_cap?: number;
    sic_description?: string;
    sic_code?: string;
    description?: string;
    homepage_url?: string;
    total_employees?: number;
    list_date?: string;
  };
}

export interface NormalizedAsset {
  asset: Asset;
  missingFields: string[];
}

export function normalizeAsset(
  payload: PolygonTickerDetails,
  symbol: string,
  retrievedAt: string,
): NormalizedAsset | null {
  const r = payload?.results;
  if (!r) return null;

  const missingFields: string[] = [];
  const assetType = mapAssetType(r.type, r.market);
  const marketCap = positiveOrNull(r.market_cap);

  const name = stringOrNull(r.name);
  if (!name) missingFields.push("name");
  const exchange = stringOrNull(r.primary_exchange);
  if (!exchange) missingFields.push("exchange");
  if (marketCap === null) missingFields.push("marketCap");

  // Polygon exposes an SIC description rather than a sector/industry pair.
  // It maps cleanly onto industry; sector needs a mapping table Polygon does
  // not provide, so it is reported missing rather than guessed.
  const industry = stringOrNull(r.sic_description);
  if (!industry) missingFields.push("industry");
  missingFields.push("sector");

  const resolvedSymbol = stringOrNull(r.ticker) ?? symbol.toUpperCase();

  return {
    asset: {
      assetId: buildAssetId(assetType, resolvedSymbol),
      symbol: resolvedSymbol,
      name,
      assetType,
      exchange,
      currency: stringOrNull(r.currency_name)?.toUpperCase() ?? null,
      sector: null,
      industry,
      marketCap,
      capTier: classifyCapTier(marketCap),
      active: typeof r.active === "boolean" ? r.active : true,
      externalIds: { [POLYGON_SOURCE_ID]: resolvedSymbol },
      createdAt: retrievedAt,
      updatedAt: retrievedAt,
    },
    missingFields,
  };
}

// ---------------------------------------------------------------------------
// Market snapshot  (GET /v2/snapshot/.../tickers/{ticker})
// ---------------------------------------------------------------------------

export interface PolygonSnapshot {
  status?: string;
  ticker?: {
    ticker?: string;
    todaysChange?: number;
    todaysChangePerc?: number;
    updated?: number;
    day?: { o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number };
    prevDay?: { o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number };
    min?: { o?: number; h?: number; l?: number; c?: number; v?: number; t?: number };
    lastTrade?: { p?: number; t?: number; s?: number };
  };
}

export interface NormalizeSnapshotArgs {
  payload: PolygonSnapshot;
  symbol: string;
  assetId: string;
  retrievedAt: string;
  provenance: Omit<Provenance, "dataTimestamp"> & { dataTimestamp?: string | null };
}

export function normalizeMarketSnapshot(args: NormalizeSnapshotArgs): {
  snapshot: MarketSnapshot;
  dataTimestamp: string | null;
} | null {
  const t = args.payload?.ticker;
  if (!t) return null;

  const missingFields: string[] = [];
  const day = t.day ?? {};
  const prev = t.prevDay ?? {};
  const min = t.min ?? {};

  // Price preference: an actual last trade beats the day aggregate, which beats
  // the current minute bar. Previous close is never used as "current price".
  const price =
    positiveOrNull(t.lastTrade?.p) ?? positiveOrNull(day.c) ?? positiveOrNull(min.c) ?? null;
  if (price === null) missingFields.push("price");

  const previousClose = positiveOrNull(prev.c);
  if (previousClose === null) missingFields.push("previousClose");

  const open = positiveOrNull(day.o);
  if (open === null) missingFields.push("open");
  const high = positiveOrNull(day.h);
  if (high === null) missingFields.push("high");
  const low = positiveOrNull(day.l);
  if (low === null) missingFields.push("low");

  // Only trust day volume once the session has actually produced a price;
  // otherwise Polygon's 0 is "no session yet", not a real zero-volume day.
  const volume = day.c !== undefined && positiveOrNull(day.c) !== null ? nonNegativeOrNull(day.v) : null;
  if (volume === null) missingFields.push("volume");

  // Prefer Polygon's own change figures; fall back to deriving them, but only
  // when both inputs genuinely exist.
  const derived = deriveChange(price, previousClose);
  const change = finiteOrNull(t.todaysChange) ?? derived.change;
  const changePercent = finiteOrNull(t.todaysChangePerc) ?? derived.changePercent;
  if (change === null) missingFields.push("change");
  if (changePercent === null) missingFields.push("changePercent");

  // Polygon's snapshot carries neither of these; they are derived later from
  // historical bars and explicitly marked as such.
  missingFields.push("averageVolume", "fiftyTwoWeekHigh", "fiftyTwoWeekLow");

  const marketTimestamp = nanosToIso(t.updated) ?? nanosToIso(t.lastTrade?.t) ?? msToIso(min.t);

  const snapshot: MarketSnapshot = {
    snapshotId: `${args.assetId}|${args.retrievedAt}`,
    assetId: args.assetId,
    symbol: args.symbol,
    price,
    previousClose,
    change,
    changePercent,
    open,
    high,
    low,
    volume,
    averageVolume: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    marketTimestamp,
    provenance: { ...args.provenance, dataTimestamp: marketTimestamp },
    missingFields,
  };

  return { snapshot, dataTimestamp: marketTimestamp };
}

/**
 * Fallback path for keys not entitled to the real-time snapshot endpoint.
 * Produces a previous-close-only snapshot, explicitly flagged so the freshness
 * layer can label it rather than passing it off as live.
 */
export interface PolygonPrevClose {
  results?: Array<{ T?: string; o?: number; h?: number; l?: number; c?: number; v?: number; t?: number }>;
}

export function normalizePrevCloseSnapshot(args: {
  payload: PolygonPrevClose;
  symbol: string;
  assetId: string;
  retrievedAt: string;
  provenance: Omit<Provenance, "dataTimestamp"> & { dataTimestamp?: string | null };
}): { snapshot: MarketSnapshot; dataTimestamp: string | null } | null {
  const bar = args.payload?.results?.[0];
  if (!bar) return null;

  const close = positiveOrNull(bar.c);
  const marketTimestamp = msToIso(bar.t);

  const missingFields = [
    "change",
    "changePercent",
    "averageVolume",
    "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow",
  ];
  if (close === null) missingFields.push("price", "previousClose");

  return {
    snapshot: {
      snapshotId: `${args.assetId}|${args.retrievedAt}`,
      assetId: args.assetId,
      symbol: args.symbol,
      // The last completed session's close is the most recent price available
      // on this path. previousClose is left null because this payload does not
      // contain the session before it.
      price: close,
      previousClose: null,
      change: null,
      changePercent: null,
      open: positiveOrNull(bar.o),
      high: positiveOrNull(bar.h),
      low: positiveOrNull(bar.l),
      volume: nonNegativeOrNull(bar.v),
      averageVolume: null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      marketTimestamp,
      provenance: { ...args.provenance, dataTimestamp: marketTimestamp },
      missingFields,
    },
    dataTimestamp: marketTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Historical prices  (GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to})
// ---------------------------------------------------------------------------

export interface PolygonAggs {
  results?: Array<{ o?: number; h?: number; l?: number; c?: number; v?: number; t?: number; vw?: number }>;
}

export function normalizeHistorical(
  payload: PolygonAggs,
  args: { symbol: string; assetId: string; retrievedAt: string },
): HistoricalPrice[] {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out: HistoricalPrice[] = [];

  for (const bar of rows) {
    const iso = msToIso(bar.t);
    if (!iso) continue; // A bar with no timestamp cannot be placed in history.
    out.push({
      assetId: args.assetId,
      symbol: args.symbol,
      date: iso.slice(0, 10),
      open: positiveOrNull(bar.o),
      high: positiveOrNull(bar.h),
      low: positiveOrNull(bar.l),
      close: positiveOrNull(bar.c),
      // Polygon's adjusted=true aggregates are already split-adjusted, but the
      // API does not return a separate unadjusted close, so there is no
      // independent adjusted value to record.
      adjustedClose: null,
      volume: nonNegativeOrNull(bar.v),
      sourceId: POLYGON_SOURCE_ID,
      retrievedAt: args.retrievedAt,
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 52-week range and average volume are computed from stored bars, not reported
 * by the snapshot endpoint. They are returned separately so the caller can tag
 * them "estimated" — derived from real data, but not directly measured.
 */
export function deriveRangeStats(bars: HistoricalPrice[]): {
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  averageVolume: number | null;
} {
  const highs = bars.map((b) => b.high ?? b.close).filter((n): n is number => n !== null);
  const lows = bars.map((b) => b.low ?? b.close).filter((n): n is number => n !== null);
  const vols = bars.map((b) => b.volume).filter((n): n is number => n !== null);

  return {
    fiftyTwoWeekHigh: highs.length ? Math.max(...highs) : null,
    fiftyTwoWeekLow: lows.length ? Math.min(...lows) : null,
    averageVolume: vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null,
  };
}

// ---------------------------------------------------------------------------
// Fundamentals  (GET /vX/reference/financials?ticker=...)
// ---------------------------------------------------------------------------

interface PolygonFinancialValue {
  value?: number;
  unit?: string;
  label?: string;
}

export interface PolygonFinancials {
  results?: Array<{
    start_date?: string;
    end_date?: string;
    fiscal_period?: string;
    fiscal_year?: string;
    financials?: {
      income_statement?: Record<string, PolygonFinancialValue>;
      balance_sheet?: Record<string, PolygonFinancialValue>;
      cash_flow_statement?: Record<string, PolygonFinancialValue>;
    };
  }>;
}

function fv(section: Record<string, PolygonFinancialValue> | undefined, key: string): number | null {
  return finiteOrNull(section?.[key]?.value);
}

export function normalizeFundamentals(
  payload: PolygonFinancials,
  args: { symbol: string; assetId: string; retrievedAt: string; provenance: Provenance },
): { fundamentals: FundamentalSnapshot; dataTimestamp: string | null } | null {
  const r = payload?.results?.[0];
  if (!r) return null;

  const income = r.financials?.income_statement;
  const balance = r.financials?.balance_sheet;

  const revenue = fv(income, "revenues");
  const earnings = fv(income, "net_income_loss");
  const eps =
    fv(income, "diluted_earnings_per_share") ?? fv(income, "basic_earnings_per_share") ?? null;
  const cash = fv(balance, "cash") ?? null;
  const debt = fv(balance, "liabilities") ?? null;

  // Margin is only meaningful when both inputs are present and revenue is real.
  const profitMargin =
    revenue !== null && earnings !== null && revenue !== 0
      ? Math.round((earnings / revenue) * 10_000) / 10_000
      : null;

  const missingFields: string[] = [];
  if (revenue === null) missingFields.push("revenue");
  if (earnings === null) missingFields.push("earnings");
  if (eps === null) missingFields.push("eps");
  if (cash === null) missingFields.push("cash");
  if (debt === null) missingFields.push("debt");
  if (profitMargin === null) missingFields.push("profitMargin");
  // Polygon's financials endpoint reports statements, not market multiples.
  missingFields.push("peRatio", "priceToSales", "priceToBook", "enterpriseValue");

  const period =
    r.fiscal_year && r.fiscal_period ? `${r.fiscal_year}${r.fiscal_period}` : stringOrNull(r.fiscal_period);
  const fiscalPeriodEnd = stringOrNull(r.end_date);

  return {
    fundamentals: {
      fundamentalId: `${args.assetId}|${period ?? args.retrievedAt}`,
      assetId: args.assetId,
      symbol: args.symbol,
      revenue,
      earnings,
      eps,
      profitMargin,
      cash,
      debt,
      valuation: {
        peRatio: null,
        priceToSales: null,
        priceToBook: null,
        enterpriseValue: null,
      },
      reportingPeriod: period,
      fiscalPeriodEnd,
      provenance: { ...args.provenance, dataTimestamp: fiscalPeriodEnd },
      missingFields,
    },
    dataTimestamp: fiscalPeriodEnd,
  };
}

/** Earnings actuals derived from the most recent filed period. */
export function normalizeEarnings(
  payload: PolygonFinancials,
  args: { symbol: string; assetId: string; provenance: Provenance },
): EarningsInfo | null {
  const r = payload?.results?.[0];
  if (!r) return null;
  const income = r.financials?.income_statement;

  return {
    assetId: args.assetId,
    symbol: args.symbol,
    reportDate: stringOrNull(r.end_date),
    period: r.fiscal_year && r.fiscal_period ? `${r.fiscal_year}${r.fiscal_period}` : null,
    // Polygon's financials endpoint reports filed actuals, never estimates.
    epsEstimate: null,
    epsActual: fv(income, "diluted_earnings_per_share") ?? fv(income, "basic_earnings_per_share"),
    revenueEstimate: null,
    revenueActual: fv(income, "revenues"),
    provenance: args.provenance,
  };
}

// ---------------------------------------------------------------------------
// News  (GET /v2/reference/news?ticker=...)
// ---------------------------------------------------------------------------

export interface PolygonNews {
  results?: Array<{
    id?: string;
    title?: string;
    description?: string;
    article_url?: string;
    published_utc?: string;
    author?: string;
    tickers?: string[];
    publisher?: { name?: string; homepage_url?: string };
  }>;
}

export function normalizeNews(
  payload: PolygonNews,
  args: { assetId: string; symbol: string; retrievedAt: string; provenance: Provenance },
): NewsItem[] {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out: NewsItem[] = [];

  for (const a of rows) {
    const headline = stringOrNull(a.title);
    if (!headline) continue; // An article with no headline is not usable.

    const publishedAt = stringOrNull(a.published_utc);
    const relatedSymbols = Array.isArray(a.tickers)
      ? a.tickers.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.toUpperCase())
      : [];
    if (!relatedSymbols.includes(args.symbol)) relatedSymbols.push(args.symbol);

    out.push({
      articleId: stringOrNull(a.id) ?? `${POLYGON_SOURCE_ID}:${headlineFingerprint(headline).slice(0, 64)}`,
      headline,
      summary: stringOrNull(a.description),
      publisher: stringOrNull(a.publisher?.name),
      publishedAt,
      relatedAssetIds: [args.assetId],
      relatedSymbols,
      sourceUrl: stringOrNull(a.article_url),
      provenance: { ...args.provenance, dataTimestamp: publishedAt },
      // A single provider cannot corroborate itself. Cross-source verification
      // is a later sprint; the field is populated honestly until then.
      verificationStatus: "unverified",
      duplicateGroupId: null,
    });
  }

  return out;
}
