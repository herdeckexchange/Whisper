import type { DataPackageService } from "../services/dataPackageService.js";
import type { SourceRegistryService } from "../services/sourceRegistryService.js";
import type { BeaconStore } from "../repositories/store.js";
import type { Scheduler } from "../jobs/scheduler.js";
import { InvalidSymbolError, NotAuthorizedError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";

/**
 * Internal Brain API.
 *
 * Written against minimal request/response shapes rather than importing Express
 * types, so this mounts unchanged on Express or any compatible router. The host
 * app supplies its own auth via `isFounder` — Beacon does not invent a second
 * authorization system alongside the one the app already has.
 */

export interface MinimalRequest {
  params: Record<string, string | undefined>;
  query: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): unknown;
}

export type RouteHandler = (req: MinimalRequest, res: MinimalResponse) => Promise<unknown>;

export interface BrainRoutesOptions {
  dataPackages: DataPackageService;
  sources: SourceRegistryService;
  store: BeaconStore;
  scheduler?: Scheduler;
  logger?: Logger;
  /**
   * Host-app authorization hook. Beacon calls this for every founder-only
   * route. Defaults to denying everything — a missing integration must fail
   * closed, never open.
   */
  isFounder?: (req: MinimalRequest) => boolean | Promise<boolean>;
  /** Master switch for the founder testing surface (env-driven). */
  founderToolsEnabled?: boolean;
}

export interface BrainRoutes {
  getDataPackage: RouteHandler;
  getSources: RouteHandler;
  getJobRuns: RouteHandler;
  postManualRefresh: RouteHandler;
}

export function createBrainRoutes(opts: BrainRoutesOptions): BrainRoutes {
  const logger = (opts.logger ?? silentLogger()).child({ component: "brainRoutes" });
  const founderToolsEnabled = opts.founderToolsEnabled ?? false;
  // Fail closed: with no hook wired up, nothing is founder-authorized.
  const isFounder = opts.isFounder ?? (() => false);

  async function requireFounder(req: MinimalRequest): Promise<void> {
    if (!founderToolsEnabled) {
      throw new NotAuthorizedError("Founder tools are disabled in this environment.");
    }
    if (!(await isFounder(req))) {
      throw new NotAuthorizedError("Founder access required.");
    }
  }

  /**
   * GET /api/brain/assets/:symbol/data-package
   *
   * The single structured response the committee agents will consume.
   */
  const getDataPackage: RouteHandler = async (req, res) => {
    const symbol = req.params.symbol ?? "";
    try {
      // Manual cache bypass is a founder-only capability: it is the one knob
      // that can burn provider quota on demand.
      let bypassCache = false;
      if (truthy(req.query.refresh)) {
        await requireFounder(req);
        bypassCache = true;
      }

      const pkg = await opts.dataPackages.build(symbol, {
        bypassCache,
        historicalLookbackDays: clampInt(req.query.lookbackDays, 400, 5, 2000),
        newsLimit: clampInt(req.query.newsLimit, 10, 1, 50),
      });

      // A partial package is still a successful response — the caller is told
      // precisely which sections are missing via `sections` and `warnings`.
      return res.status(200).json(pkg);
    } catch (e) {
      return handleError(e, res, logger, { route: "getDataPackage", symbol });
    }
  };

  /** GET /api/brain/sources — registry with health and freshness. */
  const getSources: RouteHandler = async (_req, res) => {
    try {
      return res.status(200).json({ sources: await opts.sources.list() });
    } catch (e) {
      return handleError(e, res, logger, { route: "getSources" });
    }
  };

  /** GET /api/brain/dev/job-runs — founder-only refresh history. */
  const getJobRuns: RouteHandler = async (req, res) => {
    try {
      await requireFounder(req);
      const limit = clampInt(req.query.limit, 25, 1, 200);
      return res.status(200).json({ jobRuns: await opts.store.listJobRuns(limit) });
    } catch (e) {
      return handleError(e, res, logger, { route: "getJobRuns" });
    }
  };

  /** POST /api/brain/dev/refresh — founder-only manual job trigger. */
  const postManualRefresh: RouteHandler = async (req, res) => {
    try {
      await requireFounder(req);
      if (!opts.scheduler) {
        return res.status(503).json({ error: "No scheduler is configured in this environment." });
      }
      const jobName = typeof req.query.job === "string" ? req.query.job : "refresh-prices";
      await opts.scheduler.runNow(jobName);
      return res.status(200).json({ ok: true, job: jobName, jobRuns: await opts.store.listJobRuns(1) });
    } catch (e) {
      return handleError(e, res, logger, { route: "postManualRefresh" });
    }
  };

  return { getDataPackage, getSources, getJobRuns, postManualRefresh };
}

/**
 * Error responses are deliberately plain: a client learns what went wrong and
 * nothing about provider keys, internal URLs, or stack traces.
 */
function handleError(
  e: unknown,
  res: MinimalResponse,
  logger: Logger,
  ctx: Record<string, unknown>,
): unknown {
  if (e instanceof InvalidSymbolError) {
    return res.status(400).json({ error: e.message, code: "invalid_symbol" });
  }
  if (e instanceof NotAuthorizedError) {
    // Logged at warn: repeated hits here are worth noticing.
    logger.warn("authorization denied", ctx);
    return res.status(403).json({ error: e.message, code: "forbidden" });
  }

  const message = e instanceof Error ? e.message : String(e);
  logger.error("route failed", { ...ctx, error: message });
  return res.status(500).json({ error: "Internal error building the response.", code: "internal_error" });
}

function truthy(v: unknown): boolean {
  return v === true || v === "1" || v === "true" || v === "yes";
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Convenience mount for Express hosts. Kept as a loose signature so this module
 * never needs Express as a hard dependency.
 */
export function mountBrainRoutes(router: any, routes: BrainRoutes, basePath = "/api/brain"): void {
  router.get(`${basePath}/assets/:symbol/data-package`, wrap(routes.getDataPackage));
  router.get(`${basePath}/sources`, wrap(routes.getSources));
  router.get(`${basePath}/dev/job-runs`, wrap(routes.getJobRuns));
  router.post(`${basePath}/dev/refresh`, wrap(routes.postManualRefresh));
}

/** Express 4 does not catch async rejections; this keeps them off the process. */
function wrap(handler: RouteHandler) {
  return (req: any, res: any, next: any) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}
