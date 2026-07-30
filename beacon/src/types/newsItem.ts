import type { Provenance } from "./provenance.js";

/**
 * News is where Beacon's narrative/promotion analysis will eventually live, so
 * the record carries verification and duplicate-grouping fields from day one
 * even though Phase 1 only populates them from a single provider.
 */

export const VERIFICATION_STATUSES = [
  /** Single provider reported it; no cross-check performed. */
  "unverified",
  /** Two or more independent sources carried the same story. */
  "corroborated",
  /** Flagged by a later sprint's credibility checks. */
  "disputed",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface NewsItem {
  /** Beacon-internal article ID. */
  articleId: string;
  headline: string;
  summary: string | null;
  publisher: string | null;
  publishedAt: string | null;
  /** Symbols/assets the provider (or Beacon) associates with this article. */
  relatedAssetIds: string[];
  relatedSymbols: string[];
  /** Stored internally; never proxied to the client without attribution. */
  sourceUrl: string | null;
  provenance: Provenance;
  verificationStatus: VerificationStatus;
  /**
   * Articles judged to be the same story share a duplicateGroupId. The first
   * article seen for a group becomes its representative.
   */
  duplicateGroupId: string | null;
}

/**
 * Normalizes a headline for duplicate detection: case, punctuation, and
 * whitespace are noise when the same wire story is syndicated across outlets.
 */
export function headlineFingerprint(headline: string): string {
  return headline
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
