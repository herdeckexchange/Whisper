/**
 * Provenance is the backbone of the Beacon Brain: every stored record must be
 * able to answer "where did this come from, when was it true, and do we trust
 * it right now?" Committee agents downstream are only allowed to reason over
 * records that carry this metadata.
 */

/**
 * Freshness is deliberately explicit rather than boolean. Beacon must never
 * present stale information as current, and must never silently substitute a
 * value it does not have — "missing" and "failed" are first-class outcomes.
 */
export const FRESHNESS_STATUSES = [
  /** Retrieved recently and the provider's own timestamp is inside the freshness window. */
  "fresh",
  /** Genuine data, but older than the freshness window for its category. */
  "stale",
  /** Provider explicitly serves this on a delay (e.g. 15-minute delayed quotes). */
  "delayed",
  /** Derived or interpolated rather than directly reported by the provider. */
  "estimated",
  /** Provider responded successfully but does not carry this field. */
  "missing",
  /** Retrieval failed (timeout, rate limit, auth, 5xx). No value is available. */
  "failed",
] as const;

export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

/** Freshness values that mean "we hold no usable value for this field". */
export const NON_VALUE_FRESHNESS: readonly FreshnessStatus[] = ["missing", "failed"];

export interface Provenance {
  /** Data source registry ID that produced this record. */
  sourceId: string;
  /** When the provider says the underlying measurement happened, if known. */
  dataTimestamp: string | null;
  /** When Beacon actually retrieved it. Always known. */
  retrievedAt: string;
  freshness: FreshnessStatus;
  /** Attribution text the provider's licence requires us to display, if any. */
  attribution?: string | null;
  /**
   * Populated once a second independent source confirms the same value.
   * Cross-confirmation is not implemented in Phase 1, but the field exists so
   * later sprints do not require a migration of every historical record.
   */
  confirmedBySourceIds?: string[];
}

/**
 * A value plus the reason we do or do not have it. Beacon never uses a bare
 * `null` to mean "zero" or "unknown" — the status disambiguates.
 */
export interface Provenanced<T> {
  value: T | null;
  status: FreshnessStatus;
}

export function value<T>(v: T | null | undefined, status: FreshnessStatus = "fresh"): Provenanced<T> {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) {
    return { value: null, status: "missing" };
  }
  return { value: v, status };
}

export function missing<T>(): Provenanced<T> {
  return { value: null, status: "missing" };
}

export function failed<T>(): Provenanced<T> {
  return { value: null, status: "failed" };
}

export function hasValue<T>(p: Provenanced<T> | undefined | null): p is Provenanced<T> & { value: T } {
  return !!p && p.value !== null && !NON_VALUE_FRESHNESS.includes(p.status);
}
