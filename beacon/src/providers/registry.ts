import type { DataCategory } from "../types/dataSource.js";
import type { MarketDataProvider } from "./types.js";

/**
 * Resolves which adapter serves a given data category, in priority order.
 *
 * This is the seam that makes providers replaceable: services ask the registry
 * for "whoever can serve fundamentals", never for Polygon by name. Registering
 * a second vendor ahead of Polygon is a one-line change, and is also how the
 * later cross-confirmation work will obtain two independent readings.
 */
export class ProviderRegistry {
  readonly #providers: MarketDataProvider[] = [];

  register(provider: MarketDataProvider): this {
    this.#providers.push(provider);
    return this;
  }

  /** All registered providers, in registration order. */
  all(): readonly MarketDataProvider[] {
    return this.#providers;
  }

  get(sourceId: string): MarketDataProvider | undefined {
    return this.#providers.find((p) => p.descriptor.sourceId === sourceId);
  }

  /** Highest-priority provider that can serve the category. */
  forCategory(category: DataCategory): MarketDataProvider | undefined {
    return this.#providers.find((p) => p.supports(category));
  }

  /**
   * Every provider that can serve the category, primary first. Used for
   * failover today and for multi-source confirmation in a later sprint.
   */
  allForCategory(category: DataCategory): MarketDataProvider[] {
    return this.#providers.filter((p) => p.supports(category));
  }
}
