import { randomUUID } from "node:crypto";
import type { Job } from "./scheduler.js";
import type { BeaconStore, JobRun } from "../repositories/store.js";
import type { AssetService } from "../services/assetService.js";
import type { MarketDataService } from "../services/marketDataService.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";

/**
 * Keeps a configured watchlist of symbols warm.
 *
 * Runs symbols sequentially rather than in parallel: provider rate limits are
 * per-key, and a burst of concurrent requests is the fastest way to get the
 * whole job 429'd. A refresh that takes longer but completes is worth more to
 * Beacon than a fast one that half-fails.
 *
 * Every run is recorded — successes and failures alike — so provider
 * reliability is measurable rather than anecdotal.
 */
export interface RefreshPricesJobOptions {
  symbols: string[];
  intervalMs: number;
  store: BeaconStore;
  assets: AssetService;
  market: MarketDataService;
  logger?: Logger;
  runOnStart?: boolean;
  /** Trailing bars to keep merged into history on each run. */
  historicalLookbackDays?: number;
}

export function createRefreshPricesJob(opts: RefreshPricesJobOptions): Job {
  const logger = (opts.logger ?? silentLogger()).child({ job: "refresh-prices" });
  const lookbackDays = opts.historicalLookbackDays ?? 400;

  return {
    name: "refresh-prices",
    intervalMs: opts.intervalMs,
    runOnStart: opts.runOnStart ?? false,
    run: async () => {
      const startedAt = new Date();
      const errors: JobRun["errors"] = [];
      const processed: string[] = [];

      for (const symbol of opts.symbols) {
        try {
          const assetResult = await opts.assets.resolve(symbol);
          const asset = assetResult.data;

          // History first — the snapshot's derived 52-week range reads from it.
          const historical = await opts.market.refreshHistorical(symbol, asset, lookbackDays);
          if (!historical.status.ok && historical.status.error) {
            errors.push({ symbol, message: historical.status.error, code: "historical" });
          }

          const snapshot = await opts.market.refreshSnapshot(symbol, asset);
          if (!snapshot.status.ok && snapshot.status.error) {
            errors.push({ symbol, message: snapshot.status.error, code: "snapshot" });
          }

          processed.push(symbol);
        } catch (e) {
          // One bad symbol must not abort the rest of the watchlist.
          const message = e instanceof Error ? e.message : String(e);
          errors.push({ symbol, message, code: "unhandled" });
          logger.error("symbol refresh failed", { symbol, error: message });
        }
      }

      const finishedAt = new Date();
      const status: JobRun["status"] =
        errors.length === 0 ? "success" : processed.length > 0 ? "partial" : "failed";

      await opts.store.recordJobRun({
        jobRunId: randomUUID(),
        jobName: "refresh-prices",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        status,
        symbolsProcessed: processed,
        errors,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });

      logger.info("refresh run recorded", {
        status,
        processed: processed.length,
        errors: errors.length,
      });
    },
  };
}
