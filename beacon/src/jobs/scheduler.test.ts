import { describe, it, expect, vi, afterEach } from "vitest";
import { Scheduler } from "./scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Scheduler", () => {
  it("runs a registered job on its interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler();
    scheduler.register({ name: "j", intervalMs: 1000, run });
    scheduler.start();

    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("can run immediately on start", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler();
    scheduler.register({ name: "j", intervalMs: 1000, run, runOnStart: true });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not stack overlapping runs when a job is slow", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5000));
      active--;
    });

    const scheduler = new Scheduler();
    scheduler.register({ name: "slow", intervalMs: 1000, run });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(6000);
    // A provider slower than the interval must not pile up concurrent runs.
    expect(maxActive).toBe(1);

    scheduler.stop();
  });

  it("keeps running after a job throws", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    });

    const scheduler = new Scheduler();
    scheduler.register({ name: "flaky", intervalMs: 1000, run });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    // One bad run must not take the scheduler down.
    expect(calls).toBe(2);

    scheduler.stop();
  });

  it("stops firing after stop()", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler();
    scheduler.register({ name: "j", intervalMs: 1000, run });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate job names", () => {
    const scheduler = new Scheduler();
    scheduler.register({ name: "j", intervalMs: 1000, run: async () => {} });
    expect(() => scheduler.register({ name: "j", intervalMs: 1000, run: async () => {} })).toThrow(
      /already registered/,
    );
  });

  it("rejects registration after start", () => {
    const scheduler = new Scheduler();
    scheduler.start();
    expect(() => scheduler.register({ name: "late", intervalMs: 1000, run: async () => {} })).toThrow(
      /before starting/,
    );
    scheduler.stop();
  });

  it("runs a job on demand outside its schedule", async () => {
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler();
    scheduler.register({ name: "j", intervalMs: 999_999, run });
    await scheduler.runNow("j");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("throws for an unknown job name", async () => {
    const scheduler = new Scheduler();
    await expect(scheduler.runNow("nope")).rejects.toThrow(/Unknown job/);
  });

  it("lists registered jobs", () => {
    const scheduler = new Scheduler();
    scheduler.register({ name: "a", intervalMs: 1000, run: async () => {} });
    scheduler.register({ name: "b", intervalMs: 2000, run: async () => {} });
    expect(scheduler.listJobs()).toEqual([
      { name: "a", intervalMs: 1000, running: false },
      { name: "b", intervalMs: 2000, running: false },
    ]);
  });
});
