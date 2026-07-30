import { deriveHealth, type DataSource } from "../types/dataSource.js";
import type { BeaconStore } from "../repositories/store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";

/**
 * Owns provider health and the registry rows that travel with every stored
 * record. Health is tracked here rather than inside adapters so that a provider
 * cannot mark itself healthy, and so failover decisions have one source of truth.
 */
export class SourceRegistryService {
  readonly #store: BeaconStore;
  readonly #logger: Logger;

  constructor(store: BeaconStore, logger: Logger = silentLogger()) {
    this.#store = store;
    this.#logger = logger.child({ service: "sourceRegistry" });
  }

  /** Seeds registry rows from the registered adapters. Idempotent. */
  async syncFromProviders(registry: ProviderRegistry): Promise<DataSource[]> {
    const out: DataSource[] = [];
    for (const provider of registry.all()) {
      const existing = await this.#store.getSource(provider.descriptor.sourceId);
      // Preserve accumulated health across restarts; refresh static metadata.
      const merged: DataSource = existing
        ? {
            ...provider.descriptor,
            lastSuccessfulRefresh: existing.lastSuccessfulRefresh,
            lastFailedRefresh: existing.lastFailedRefresh,
            lastFailureReason: existing.lastFailureReason,
            consecutiveFailures: existing.consecutiveFailures,
            healthStatus: existing.healthStatus,
          }
        : provider.descriptor;
      out.push(await this.#store.upsertSource({ ...merged, updatedAt: new Date().toISOString() }));
    }
    return out;
  }

  async recordSuccess(sourceId: string, at = new Date().toISOString()): Promise<void> {
    const source = await this.#store.getSource(sourceId);
    if (!source) return;
    await this.#store.upsertSource({
      ...source,
      lastSuccessfulRefresh: at,
      consecutiveFailures: 0,
      healthStatus: deriveHealth(0),
      lastFailureReason: null,
      updatedAt: at,
    });
  }

  async recordFailure(sourceId: string, reason: string, at = new Date().toISOString()): Promise<void> {
    const source = await this.#store.getSource(sourceId);
    if (!source) return;
    const consecutiveFailures = source.consecutiveFailures + 1;
    const healthStatus = deriveHealth(consecutiveFailures);

    // A provider crossing into "failing" is the signal an operator needs, so it
    // is logged at error level rather than buried among per-request warnings.
    this.#logger[healthStatus === "failing" ? "error" : "warn"]("provider failure recorded", {
      sourceId,
      consecutiveFailures,
      healthStatus,
      reason,
    });

    await this.#store.upsertSource({
      ...source,
      lastFailedRefresh: at,
      lastFailureReason: reason,
      consecutiveFailures,
      healthStatus,
      updatedAt: at,
    });
  }

  async get(sourceId: string): Promise<DataSource | null> {
    return this.#store.getSource(sourceId);
  }

  async list(): Promise<DataSource[]> {
    return this.#store.listSources();
  }

  /** Most recent successful refresh across the given sources. */
  async lastSuccessfulRefresh(sourceIds: string[]): Promise<string | null> {
    let latest: string | null = null;
    for (const id of sourceIds) {
      const s = await this.#store.getSource(id);
      if (!s?.lastSuccessfulRefresh) continue;
      if (!latest || Date.parse(s.lastSuccessfulRefresh) > Date.parse(latest)) {
        latest = s.lastSuccessfulRefresh;
      }
    }
    return latest;
  }
}
