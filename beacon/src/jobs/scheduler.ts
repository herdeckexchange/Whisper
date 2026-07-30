import type { Logger } from "../lib/logger.js";
import { silentLogger } from "../lib/logger.js";

/**
 * Minimal interval scheduler.
 *
 * Deliberately dependency-free and category-agnostic: Phase 1 only needs the
 * price job, but prices, fundamentals, news, filings, and social ingestion all
 * refresh on different cadences, so jobs register their own interval rather
 * than sharing a global tick.
 *
 * Two properties the later jobs depend on: a run never overlaps itself (a slow
 * provider must not stack up concurrent runs), and a thrown error is recorded
 * and swallowed (one bad run must not kill the scheduler).
 */

export interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  /** Run once immediately on start rather than waiting a full interval. */
  runOnStart?: boolean;
}

interface Scheduled {
  job: Job;
  timer: NodeJS.Timeout;
  running: boolean;
}

export class Scheduler {
  readonly #jobs = new Map<string, Scheduled>();
  readonly #logger: Logger;
  #started = false;

  constructor(logger: Logger = silentLogger()) {
    this.#logger = logger.child({ component: "scheduler" });
  }

  register(job: Job): this {
    if (this.#jobs.has(job.name)) {
      throw new Error(`Job "${job.name}" is already registered.`);
    }
    if (this.#started) {
      throw new Error("Register jobs before starting the scheduler.");
    }
    // Placeholder timer; replaced on start().
    this.#jobs.set(job.name, { job, timer: undefined as unknown as NodeJS.Timeout, running: false });
    return this;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    for (const entry of this.#jobs.values()) {
      const timer = setInterval(() => void this.#invoke(entry), entry.job.intervalMs);
      // Do not hold the Node event loop open purely for a refresh timer.
      timer.unref?.();
      entry.timer = timer;

      this.#logger.info("job registered", {
        job: entry.job.name,
        intervalMs: entry.job.intervalMs,
      });

      if (entry.job.runOnStart) void this.#invoke(entry);
    }
  }

  stop(): void {
    for (const entry of this.#jobs.values()) {
      clearInterval(entry.timer);
    }
    this.#started = false;
    this.#logger.info("scheduler stopped");
  }

  /** Runs a registered job immediately, outside its schedule. */
  async runNow(name: string): Promise<void> {
    const entry = this.#jobs.get(name);
    if (!entry) throw new Error(`Unknown job "${name}".`);
    await this.#invoke(entry);
  }

  listJobs(): Array<{ name: string; intervalMs: number; running: boolean }> {
    return [...this.#jobs.values()].map((e) => ({
      name: e.job.name,
      intervalMs: e.job.intervalMs,
      running: e.running,
    }));
  }

  async #invoke(entry: Scheduled): Promise<void> {
    // A slow provider must not cause runs to pile up on top of each other.
    if (entry.running) {
      this.#logger.warn("skipping run — previous run still in flight", { job: entry.job.name });
      return;
    }

    entry.running = true;
    const startedAt = Date.now();
    try {
      await entry.job.run();
      this.#logger.info("job completed", {
        job: entry.job.name,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      // Swallowed on purpose: the job itself records the failure, and one bad
      // run must not take the scheduler down with it.
      this.#logger.error("job threw", {
        job: entry.job.name,
        durationMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      entry.running = false;
    }
  }
}
