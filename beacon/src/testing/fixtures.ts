/**
 * Recorded-shape Polygon payloads used across the test suite.
 *
 * These mirror the real response envelopes (including the awkward parts:
 * nanosecond timestamps, zero-filled pre-open OHLC, the `results` vs `ticker`
 * split) so normalizer tests exercise what the vendor actually sends rather
 * than an idealised version of it.
 */

export const NVDA_TICKER_DETAILS = {
  status: "OK",
  results: {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    market: "stocks",
    locale: "us",
    primary_exchange: "XNAS",
    type: "CS",
    active: true,
    currency_name: "usd",
    market_cap: 3_120_000_000_000,
    sic_code: "3674",
    sic_description: "Semiconductors & Related Devices",
    total_employees: 29600,
    list_date: "1999-01-22",
  },
};

/** Mid-session snapshot: day bar populated, last trade present. */
export const NVDA_SNAPSHOT = {
  status: "OK",
  ticker: {
    ticker: "NVDA",
    todaysChange: 2.35,
    todaysChangePerc: 1.82,
    // Polygon reports this field in NANOseconds.
    updated: 1_733_500_800_000_000_000,
    day: { o: 129.5, h: 132.4, l: 128.9, c: 131.6, v: 245_000_000, vw: 131.02 },
    prevDay: { o: 127.1, h: 129.9, l: 126.8, c: 129.25, v: 210_000_000, vw: 128.4 },
    min: { o: 131.4, h: 131.8, l: 131.3, c: 131.6, v: 850_000, t: 1_733_500_800_000 },
    lastTrade: { p: 131.6, t: 1_733_500_800_000_000_000, s: 100 },
  },
};

/**
 * Pre-open snapshot. Polygon zero-fills the day bar before the session starts —
 * the normalizer must not publish these zeros as a real $0 price.
 */
export const NVDA_SNAPSHOT_PREOPEN = {
  status: "OK",
  ticker: {
    ticker: "NVDA",
    todaysChange: 0,
    todaysChangePerc: 0,
    updated: 1_733_500_800_000_000_000,
    day: { o: 0, h: 0, l: 0, c: 0, v: 0, vw: 0 },
    prevDay: { o: 127.1, h: 129.9, l: 126.8, c: 129.25, v: 210_000_000, vw: 128.4 },
    min: { o: 0, h: 0, l: 0, c: 0, v: 0, t: 0 },
    lastTrade: { p: 0, t: 0, s: 0 },
  },
};

export const NVDA_PREV_CLOSE = {
  status: "OK",
  ticker: "NVDA",
  results: [
    { T: "NVDA", o: 127.1, h: 129.9, l: 126.8, c: 129.25, v: 210_000_000, t: 1_733_414_400_000 },
  ],
};

export const NVDA_AGGS = {
  status: "OK",
  ticker: "NVDA",
  results: [
    { o: 120.0, h: 124.0, l: 119.5, c: 123.4, v: 180_000_000, t: 1_733_155_200_000 },
    { o: 123.5, h: 128.2, l: 123.0, c: 127.1, v: 195_000_000, t: 1_733_241_600_000 },
    { o: 127.1, h: 129.9, l: 126.8, c: 129.25, v: 210_000_000, t: 1_733_414_400_000 },
  ],
};

export const NVDA_FINANCIALS = {
  status: "OK",
  results: [
    {
      start_date: "2024-07-29",
      end_date: "2024-10-27",
      fiscal_period: "Q3",
      fiscal_year: "2025",
      financials: {
        income_statement: {
          revenues: { value: 35_082_000_000, unit: "USD" },
          net_income_loss: { value: 19_309_000_000, unit: "USD" },
          basic_earnings_per_share: { value: 0.79, unit: "USD / shares" },
          diluted_earnings_per_share: { value: 0.78, unit: "USD / shares" },
        },
        balance_sheet: {
          cash: { value: 9_107_000_000, unit: "USD" },
          liabilities: { value: 30_112_000_000, unit: "USD" },
        },
      },
    },
  ],
};

export const NVDA_NEWS = {
  status: "OK",
  results: [
    {
      id: "art-1",
      title: "NVIDIA beats expectations on data centre demand",
      description: "Quarterly revenue rose sharply.",
      article_url: "https://example.com/a",
      published_utc: "2024-11-21T10:00:00Z",
      author: "Reporter A",
      tickers: ["NVDA"],
      publisher: { name: "Example Wire", homepage_url: "https://example.com" },
    },
    {
      // Same story, different outlet, punctuation/case differences only.
      id: "art-2",
      title: "NVIDIA Beats Expectations on Data Centre Demand!",
      description: "Syndicated copy of the same wire story.",
      article_url: "https://other.example.com/b",
      published_utc: "2024-11-21T11:30:00Z",
      author: "Reporter B",
      tickers: ["NVDA"],
      publisher: { name: "Other Outlet", homepage_url: "https://other.example.com" },
    },
    {
      id: "art-3",
      title: "Chip sector outlook for 2025",
      description: "Analysts weigh in.",
      article_url: "https://example.com/c",
      published_utc: "2024-11-20T08:00:00Z",
      tickers: ["NVDA", "AMD"],
      publisher: { name: "Example Wire" },
    },
  ],
};

/**
 * Builds a fetch stub that routes by URL fragment. Anything unmatched throws,
 * so a test that accidentally hits an unstubbed endpoint fails loudly rather
 * than silently returning undefined.
 */
export interface StubRoute {
  match: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw a network-style error instead of responding. */
  throws?: Error;
  /** Never settle — used to exercise timeout handling. */
  hang?: boolean;
}

export function stubFetch(routes: StubRoute[]): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    calls.push(href);

    const route = routes.find((r) => href.includes(r.match));
    if (!route) {
      throw new Error(`No stub route matched: ${href}`);
    }
    if (route.throws) throw route.throws;

    if (route.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }

    const status = route.status ?? 200;
    const headers = new Headers(route.headers ?? {});

    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body ?? ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** Backoff sleeps are replaced with a no-op so retry tests run instantly. */
export const noSleep = async () => {};
