import { loadEnv, type BeaconEnv } from "./config/env.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { MemoryStore } from "./repositories/memoryStore.js";
import type { BeaconStore } from "./repositories/store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { PolygonProvider } from "./providers/polygon/polygonProvider.js";
import { SourceRegistryService } from "./services/sourceRegistryService.js";
import { AssetService } from "./services/assetService.js";
import { MarketDataService } from "./services/marketDataService.js";
import { FundamentalsService } from "./services/fundamentalsService.js";
import { NewsService } from "./services/newsService.js";
import { DataPackageService } from "./services/dataPackageService.js";
import { Scheduler } from "./jobs/scheduler.js";
import { createRefreshPricesJob } from "./jobs/refreshPricesJob.js";
import { createBrainRoutes, type BrainRoutes, type MinimalRequest } from "./routes/brainRoutes.js";

/**
 * Composition root for the Beacon Brain data foundation.
 *
 * The host app calls createBeaconBrain() once at startup, mounts the returned
 * routes, and starts the scheduler. Nothing else in the app should construct
 * providers or services directly.
 */

export interface CreateBeaconBrainOptions {
  /** Defaults to process.env; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to MemoryStore. Supply a Postgres-backed store in production. */
  store?: BeaconStore;
  logger?: Logger;
  /**
   * Host-app authorization hook for founder-only routes. Wire this to the
   * app's existing auth — Beacon deliberately does not define its own.
   */
  isFounder?: (req: MinimalRequest) => boolean | Promise<boolean>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface BeaconBrain {
  env: BeaconEnv;
  store: BeaconStore;
  logger: Logger;
  registry: ProviderRegistry;
  services: {
    sources: SourceRegistryService;
    assets: AssetService;
    market: MarketDataService;
    fundamentals: FundamentalsService;
    news: NewsService;
    dataPackages: DataPackageService;
  };
  scheduler: Scheduler;
  routes: BrainRoutes;
  /** Seeds the source registry and starts scheduled refresh jobs. */
  start(): Promise<void>;
  stop(): void;
}

export async function createBeaconBrain(
  opts: CreateBeaconBrainOptions = {},
): Promise<BeaconBrain> {
  // Throws EnvValidationError listing every problem — fail fast and loudly
  // rather than surfacing a confusing 401 mid-refresh.
  const env = loadEnv(opts.env ?? process.env);

  const logger =
    opts.logger ??
    createLogger({
      level: "info",
      // Every log line is scrubbed of the provider key before emission.
      secrets: [env.POLYGON_API_KEY],
    });

  const store = opts.store ?? new MemoryStore();

  const registry = new ProviderRegistry().register(
    new PolygonProvider({
      apiKey: env.POLYGON_API_KEY,
      baseUrl: env.POLYGON_BASE_URL,
      timeoutMs: env.BEACON_HTTP_TIMEOUT_MS,
      maxRetries: env.BEACON_HTTP_MAX_RETRIES,
      cacheTtlMs: env.BEACON_CACHE_TTL_MS,
      logger,
      fetchImpl: opts.fetchImpl,
    }),
  );

  const sources = new SourceRegistryService(store, logger);
  const assets = new AssetService({ store, registry, sources, logger });
  const market = new MarketDataService({
    store,
    registry,
    sources,
    staleAfterMs: env.BEACON_SNAPSHOT_STALE_AFTER_MS,
    logger,
  });
  const fundamentals = new FundamentalsService({ store, registry, sources, logger });
  const news = new NewsService({ store, registry, sources, logger });
  const dataPackages = new DataPackageService({
    assets,
    market,
    fundamentals,
    news,
    sources,
    logger,
  });

  const scheduler = new Scheduler(logger);
  scheduler.register(
    createRefreshPricesJob({
      symbols: env.BEACON_REFRESH_SYMBOLS,
      intervalMs: env.BEACON_PRICE_REFRESH_INTERVAL_MS,
      store,
      assets,
      market,
      logger,
    }),
  );

  const routes = createBrainRoutes({
    dataPackages,
    sources,
    store,
    scheduler,
    logger,
    isFounder: opts.isFounder,
    founderToolsEnabled: env.BEACON_ENABLE_FOUNDER_TOOLS,
  });

  return {
    env,
    store,
    logger,
    registry,
    services: { sources, assets, market, fundamentals, news, dataPackages },
    scheduler,
    routes,
    async start() {
      // Registry rows must exist before any service tries to record health.
      await sources.syncFromProviders(registry);
      scheduler.start();
      logger.info("beacon brain started", {
        refreshSymbols: env.BEACON_REFRESH_SYMBOLS,
        founderTools: env.BEACON_ENABLE_FOUNDER_TOOLS,
      });
    },
    stop() {
      scheduler.stop();
    },
  };
}

// Public surface for the host app and for the committee work that follows.
export * from "./types/asset.js";
export * from "./types/marketSnapshot.js";
export * from "./types/historicalPrice.js";
export * from "./types/fundamentals.js";
export * from "./types/newsItem.js";
export * from "./types/dataSource.js";
export * from "./types/dataPackage.js";
export * from "./types/provenance.js";
export { MemoryStore } from "./repositories/memoryStore.js";
export type { BeaconStore, JobRun } from "./repositories/store.js";
export { ProviderRegistry } from "./providers/registry.js";
export { PolygonProvider } from "./providers/polygon/polygonProvider.js";
export type { MarketDataProvider, ProviderResult } from "./providers/types.js";
export { Scheduler } from "./jobs/scheduler.js";
export { createRefreshPricesJob } from "./jobs/refreshPricesJob.js";
export { createBrainRoutes, mountBrainRoutes } from "./routes/brainRoutes.js";
export type { MinimalRequest, MinimalResponse } from "./routes/brainRoutes.js";
export { InvalidSymbolError, NotAuthorizedError, ProviderError } from "./lib/errors.js";
export { normalizeSymbol, isValidSymbol } from "./lib/symbol.js";
export { classifyFreshness } from "./lib/freshness.js";
export { createLogger, silentLogger } from "./lib/logger.js";
export { loadEnv, EnvValidationError, redactSecrets } from "./config/env.js";
