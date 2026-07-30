# Beacon Brain — Phase 1 Data Foundation

The modular data layer that supplies the future Beacon intelligence committees.
It retrieves real market data, normalizes it into Beacon's internal schemas,
stores it with full provenance, refreshes it on a schedule, and exposes it as a
single structured data package.

**This sprint deliberately stops at data.** No Beacon Score, no Top 3, no
committee voting, no buy/sell/wait verdicts. Those consume what this produces.

---

## Why this lives in a standalone package

Beacon runs on Replit, and this package was built without access to that
codebase. It is therefore **self-contained and additive**: it defines no routes
on your app, imports no framework, and creates no auth system. You mount it.

The one integration point you must supply is authorization — see
[Wiring it in](#wiring-it-in). Beacon calls back into *your* existing auth
rather than inventing a parallel one.

---

## Architecture

```
beacon/
  schema.sql                     Postgres DDL (production storage target)
  scripts/
    smoke.ts                     Live end-to-end check against a real key
    fakePolygon.ts               Local API stand-in for offline verification
  src/
    config/env.ts                Env validation + secret redaction
    lib/
      errors.ts                  Typed provider errors (retryable vs not)
      http.ts                    Timeouts, capped retries, rate-limit handling
      cache.ts                   Short-TTL request coalescing
      freshness.ts               fresh/stale/delayed/estimated/missing/failed
      symbol.ts                  Allowlist validation of user input
      logger.ts                  Structured JSON logs, secrets scrubbed
    types/                       Normalized contracts (the committee's API)
    providers/
      types.ts                   MarketDataProvider interface
      registry.ts                Category -> adapter resolution
      polygon/polygonProvider.ts Polygon adapter (transport + shape only)
    normalizers/                 Vendor payloads -> Beacon schemas
    repositories/                Storage contract + in-memory implementation
    services/                    Retrieval, persistence, package assembly
    jobs/                        Scheduler + price refresh job
    routes/                      Internal API
    testing/                     Fixtures + founder inspector panel
```

**The seam that matters:** services depend on the `MarketDataProvider`
interface and ask the registry for *"whoever serves fundamentals"* — never for
Polygon by name. Swapping or adding a vendor is a registration change, not a
rewrite. This is also how cross-source confirmation will work later.

---

## Data flow

```
symbol ──▶ validate ──▶ provider adapter ──▶ normalizer ──▶ store (append-only)
                              │                                    │
                              ▼                                    ▼
                       source registry                      data package
                       (health, failures)                   (+ provenance)
```

---

## The two non-negotiable guarantees

### 1. Nothing is ever fabricated or silently substituted

A missing value is `null` **plus a status explaining why**. There is no
fallback to zero, to a last-known value, or to an estimate presented as a
measurement.

Concrete cases this already handles:

- Polygon zero-fills OHLC before the market opens. A `0` price becomes `null` +
  `missingFields: ["price"]`, never a $0 quote.
- `change` is only derived when *both* price and previous close genuinely exist.
- 52-week range and average volume are computed from stored bars, and the
  section is flagged so a committee knows they are derived, not reported.
- A failed section yields `null` data and an honest error string. The rest of
  the package still assembles.

### 2. History is append-only

Snapshots, historical bars, and fundamentals **append**. A refresh adds a row;
it never overwrites one. This is what lets Beacon later reconstruct exactly what
it knew at the moment a past recommendation was made, and measure source
reliability over time.

`schema.sql` enforces this with a trigger, not just convention:

```sql
CREATE TRIGGER market_snapshots_append_only
  BEFORE UPDATE OR DELETE ON market_snapshots
  FOR EACH ROW EXECUTE FUNCTION beacon_block_mutation();
```

Only `assets` and `data_sources` — present-tense identity and health — update
in place.

---

## Wiring it in

```ts
import { createBeaconBrain, mountBrainRoutes } from "./beacon/src/index.js";

const brain = await createBeaconBrain({
  // REQUIRED: delegate to your app's existing auth.
  // Defaults to denying everything — a missing hook fails closed, never open.
  isFounder: (req) => req.user?.role === "founder",

  // Optional: defaults to MemoryStore (see Known limitations).
  // store: new PostgresStore(pool),
});

await brain.start();               // seeds source registry, starts refresh jobs
mountBrainRoutes(app, brain.routes);
```

That is the whole integration. It adds routes under `/api/brain` and touches
nothing else — no navigation, no existing screens, no onboarding, no
subscription flow.

---

## Environment variables

Copy into **Replit Secrets** (Tools → Secrets). Server-side only; none of these
may reach the client bundle.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `POLYGON_API_KEY` | **yes** | — | Polygon.io key. Sent as a `Bearer` header, never a query param. |
| `POLYGON_BASE_URL` | no | `https://api.polygon.io` | Override for testing. |
| `BEACON_HTTP_TIMEOUT_MS` | no | `8000` | Per-request timeout. |
| `BEACON_HTTP_MAX_RETRIES` | no | `3` | Retry budget for transient failures. |
| `BEACON_SNAPSHOT_STALE_AFTER_MS` | no | `900000` | Age at which a quote is stale. |
| `BEACON_CACHE_TTL_MS` | no | `60000` | Request-coalescing TTL. |
| `BEACON_PRICE_REFRESH_INTERVAL_MS` | no | `300000` | Refresh job cadence. |
| `BEACON_REFRESH_SYMBOLS` | no | `NVDA` | Comma-separated watchlist. |
| `BEACON_ENABLE_FOUNDER_TOOLS` | no | `false` | Master switch for founder routes. |

Validation runs once at startup and reports **every** problem at once rather
than failing on the first. A placeholder key (`your-api-key…`) is rejected.

---

## API

### `GET /api/brain/assets/:symbol/data-package`

The single structured response the committee agents will consume.

Query params: `?refresh=true` (founder-only, bypasses cache),
`?lookbackDays=400`, `?newsLimit=10`.

```jsonc
{
  "symbol": "NVDA",
  "assetId": "stock:NVDA",
  "generatedAt": "…",
  "asset":            { /* identity, sector, cap tier */ },
  "marketSnapshot":   { /* price, OHLCV, 52w range, provenance */ },
  "historicalPrices": [ /* daily bars */ ],
  "fundamentals":     { /* revenue, earnings, EPS, margin */ },
  "earnings":         { /* filed actuals */ },
  "news":             [ /* de-duplicated articles */ ],

  // Per-section provider + freshness. This is the part committees must read.
  "sections": {
    "marketSnapshot": {
      "ok": true, "sourceId": "polygon.io", "providerName": "Polygon.io",
      "freshness": "fresh", "retrievedAt": "…", "dataTimestamp": "…",
      "error": null, "missingFields": []
    }
    // … asset, historicalPrices, fundamentals, news, earnings
  },

  "sources":  [ /* registry rows: health, reliability tier, attribution */ ],
  "warnings": [ { "section": "asset", "code": "missing_fields", "message": "…" } ],
  "lastSuccessfulRefresh": "…",
  "complete": true          // false when any section failed
}
```

A partial package returns **200**, not an error. The caller is told precisely
which sections are missing and why. Committees should treat `complete: false`
as lower-confidence input rather than proceeding blindly.

| Route | Access |
|---|---|
| `GET /api/brain/assets/:symbol/data-package` | open (app auth) |
| `GET /api/brain/sources` | open (app auth) |
| `GET /api/brain/dev/job-runs` | founder only |
| `POST /api/brain/dev/refresh` | founder only |

Errors: `400` invalid symbol · `403` forbidden · `500` internal (never leaks
internals, connection strings, or stack traces).

---

## Founder testing panel

`src/testing/founderPanel.ts` exports `renderFounderPanelHtml()` — a
single self-contained page (no build step, no framework, no styling opinions)
that lets you enter a symbol and see the normalized response, the provider
behind each section, timestamps and freshness, missing fields, provider errors,
and a manual refresh trigger.

Serve it behind the same founder check as the API:

```ts
app.get("/dev/beacon", requireFounder, (_req, res) =>
  res.send(renderFounderPanelHtml({ basePath: "/api/brain" })),
);
```

It is a debugging surface, not a product screen. It changes no existing UI.

---

## Freshness model

| Status | Meaning |
|---|---|
| `fresh` | Provider timestamp inside the window for its category. |
| `stale` | Genuine data, but older than its window. **Never present as current.** |
| `delayed` | Provider serves this feed on a known delay. |
| `estimated` | Derived from real data, not directly reported. |
| `missing` | Provider responded, but does not carry this field. |
| `failed` | Retrieval failed. No value exists. |

Freshness is computed from the **provider's** data timestamp, not from when
Beacon fetched it — re-fetching a three-day-old quote does not make it fresh.

---

## Running

```bash
cd beacon
npm install
npm test          # 127 tests
npm run typecheck

# Live check against the real API (needs a key + outbound access)
POLYGON_API_KEY=… npx tsx scripts/smoke.ts NVDA

# Offline end-to-end check over real HTTP, no key needed
npx tsx scripts/fakePolygon.ts 8787 &
POLYGON_API_KEY=pk_test_local12345 POLYGON_BASE_URL=http://127.0.0.1:8787 \
  npx tsx scripts/smoke.ts NVDA
```

---

## Test coverage

127 tests across 9 files, all passing:

| Area | Covers |
|---|---|
| `polygonNormalizer.test.ts` (26) | Field mapping, ns/ms timestamps, pre-open zeros, absent optional fields, derived stats |
| `http.test.ts` (15) | Timeout, retry+backoff, 429 with `Retry-After`, non-retryable 401/404, key redaction in logs |
| `memoryStore.test.ts` (16) | Append-only history, bar immutability, news dedup, restatements, job runs |
| `brainRoutes.test.ts` (14) | Package shape, invalid symbols, founder authorization, fail-closed default, no key leakage |
| `env.test.ts` (12) | Validation, placeholder rejection, multi-issue reporting, redaction |
| `dataPackage.integration.test.ts` (17) | Full pipeline, partial degradation, provider health, plan-limitation fallback, refresh job |
| `scheduler.test.ts` (10) | Interval firing, no overlapping runs, survives a throwing job |
| `freshness.test.ts` (9) | Stale detection, clock skew, provider delay |
| `symbol.test.ts` (8) | Traversal/injection rejection, multi-asset-class symbols |

---

## Security

- Provider key is sent as a `Bearer` header, never a query parameter, so it
  cannot leak via logged URLs or proxy access logs.
- Every log line passes through `redactSecrets()`; a 401 body is never echoed
  because it can contain the submitted key.
- Symbols are validated against an allowlist before reaching a provider or the
  store — traversal, injection, and query-injection attempts are rejected.
- Founder routes fail closed: with no `isFounder` hook wired up, nothing is
  authorized.
- Error responses never expose internals or connection strings.
- No brokerage connection, no trade execution.

---

## Known limitations

Read this section before building on top.

1. **Default store is in-memory.** State is lost on restart, and Replit
   containers restart routinely. `schema.sql` is the production target; a
   `PostgresStore` implementing `BeaconStore` is the first thing to build.
2. **Not verified against the live Polygon API.** The sandbox this was built in
   had no Polygon key and blocked outbound access to `api.polygon.io`. It *was*
   verified end-to-end over real HTTP against `scripts/fakePolygon.ts` replaying
   recorded payloads. **Run `scripts/smoke.ts` with a real key before trusting
   it in production** — field-level surprises are possible.
3. **Sector is always null.** Polygon exposes SIC descriptions (mapped to
   `industry`), not sectors. A SIC→sector mapping or a second provider is needed.
4. **Valuation multiples are always null.** Polygon's financials endpoint reports
   statements, not P/E or P/S. Compute from price × shares outstanding, or add a
   provider.
5. **Earnings are filed actuals only** — no forward estimates or scheduled dates.
6. **De-duplication is headline-fingerprint based.** It catches syndication and
   case/punctuation variants, not rewrites. `verificationStatus` is always
   `unverified` because one provider cannot corroborate itself.
7. **US equities only in practice.** Schemas and symbol validation already admit
   crypto, options, and ETFs; only the Polygon stock endpoints are wired.
8. **No social/narrative connectors** — by design. The `DataCategory` enum and
   source registry reserve space for them.
9. **Scheduler is in-process.** Multiple Replit instances would each run their
   own jobs. Needs a lock or an external scheduler when you scale out.

---

## Next engineering step

**Implement `PostgresStore`** against `schema.sql` and swap it in via
`createBeaconBrain({ store })`. Everything else is already storage-agnostic, and
without durable storage the append-only history — the thing the Learning Engine
and recommendation-outcome tracking depend on — does not survive a restart.

Do that, run `scripts/smoke.ts` with a real key, and only then connect the
normalized data package to the first Beacon committee.
