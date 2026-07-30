import { z } from "zod";

/**
 * Environment validation happens once, at startup, and fails loudly. A missing
 * provider key must not surface later as a confusing 401 in the middle of a
 * refresh job.
 *
 * Secrets live only in this module's returned object — they are never logged,
 * never attached to error messages, and never serialised into API responses.
 */

const intFromEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return fallback;
      return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    })
    .pipe(z.boolean());

const envSchema = z.object({
  POLYGON_API_KEY: z
    .string()
    .min(1, "POLYGON_API_KEY is required. Add it to Replit Secrets (server-side only).")
    // Guard against the classic mistake of pasting a placeholder.
    .refine((v) => !/^(your|xxx|changeme|placeholder)/i.test(v.trim()), {
      message: "POLYGON_API_KEY looks like a placeholder rather than a real key.",
    }),
  POLYGON_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim().replace(/\/+$/, "") : "https://api.polygon.io"))
    .pipe(z.string().url()),

  BEACON_HTTP_TIMEOUT_MS: intFromEnv(8_000, 500, 120_000),
  BEACON_HTTP_MAX_RETRIES: intFromEnv(3, 0, 10),
  BEACON_SNAPSHOT_STALE_AFTER_MS: intFromEnv(15 * 60_000, 1_000, 24 * 3_600_000),
  BEACON_CACHE_TTL_MS: intFromEnv(60_000, 0, 3_600_000),
  BEACON_PRICE_REFRESH_INTERVAL_MS: intFromEnv(5 * 60_000, 10_000, 24 * 3_600_000),

  BEACON_REFRESH_SYMBOLS: z
    .string()
    .optional()
    .transform((v) =>
      (v && v.trim() !== "" ? v : "NVDA")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),

  BEACON_ENABLE_FOUNDER_TOOLS: boolFromEnv(false),
});

export type BeaconEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  public readonly issues: string[];
  constructor(issues: string[]) {
    super(`Beacon environment is not configured correctly:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Parses and validates env. Throws EnvValidationError listing every problem at
 * once rather than failing on the first missing variable.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): BeaconEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const key = i.path.join(".") || "(root)";
      return `${key}: ${i.message}`;
    });
    throw new EnvValidationError(issues);
  }
  return parsed.data;
}

/**
 * Redacts secret-looking values from anything headed for a log line.
 * Applied to URLs (Polygon puts the key in a query param) and error text.
 */
export function redactSecrets(input: string, secrets: string[] = []): string {
  let out = input;
  for (const s of secrets) {
    if (s && s.length >= 6) {
      out = out.split(s).join("[REDACTED]");
    }
  }
  // Polygon and many vendors accept the key as a query parameter.
  out = out.replace(/([?&](apiKey|api_key|apikey|token|access_token)=)[^&\s]+/gi, "$1[REDACTED]");
  // Bearer tokens in any echoed header.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]");
  return out;
}
