import { describe, it, expect, afterEach, spyOn, mock } from "bun:test";

// Leak-safe mock.module() pattern (same as tests/ai-improve.test.ts / tests/diffusion-caption.test.ts):
// capture the REAL implementation BEFORE mock.module() swaps it in, then delegate through a mutable
// variable that defaults to (and is reset back to, in afterEach below) the real implementation. That
// keeps tests/publish-due.test.ts and tests/wp-publish.test.ts — which import publishDueArticles
// directly and exercise it against the real DB — seeing real behavior in a combined `bun test` run,
// even though this file's mock.module() registration is process-wide.
const { publishDueArticles: realPublishDueArticles } = await import("@/lib/wp/publish-due");

let publishDueArticlesImpl: typeof realPublishDueArticles = realPublishDueArticles;

mock.module("@/lib/wp/publish-due", () => ({
  publishDueArticles: (...args: Parameters<typeof realPublishDueArticles>) => publishDueArticlesImpl(...args),
}));

// triggerScheduledPublishDue itself does a dynamic `await import("@/lib/wp/publish-due")` at call
// time (lib/pipeline/scheduler.ts), so import ordering relative to the mock.module() call above isn't
// strictly load-bearing here — but importing after registration matches the rest of the codebase's
// convention for files that DO rely on static-import resolution order.
const {
  initScheduler,
  triggerScheduledPublishDue,
  getPublishDueSchedulerJob,
} = await import("@/lib/pipeline/scheduler");

afterEach(() => {
  // Always reset to the real implementation so no test in this file (or any file that happens to run
  // afterwards in the same process) ever observes the mocked/throwing version outside its own test.
  publishDueArticlesImpl = realPublishDueArticles;
});

// ─────────────────────────────────────────────────────────────────────────────
// startPublishDueScheduler (lib/pipeline/scheduler.ts) is not exported — same shape as the existing
// startDiffusionScheduler — so it's exercised the same way tests/diffusion-scheduler.test.ts exercises
// its own equivalent: through the public entrypoints, initScheduler() and the job accessor. No timing
// involved: initScheduler() only SCHEDULES the job, it never waits on a real cron fire.
describe("startPublishDueScheduler (via initScheduler) — unconditional, idempotent", () => {
  it("creates a job on the first call, with a future nextRun()", async () => {
    await initScheduler();
    const job = getPublishDueSchedulerJob();
    expect(job).not.toBeNull();
    const next = job!.nextRun();
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not recreate the job on a second call — same instance", async () => {
    await initScheduler();
    const first = getPublishDueSchedulerJob();
    expect(first).not.toBeNull();

    await initScheduler();
    const second = getPublishDueSchedulerJob();
    expect(second).toBe(first);
  });
});

describe("getPublishDueSchedulerJob", () => {
  it("returns non-null after initScheduler()", async () => {
    await initScheduler();
    expect(getPublishDueSchedulerJob()).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// triggerScheduledPublishDue: exported so tests can call it directly instead of waiting on a real
// cron fire, exactly like triggerScheduledDiffusionTick's own tests.
describe("triggerScheduledPublishDue", () => {
  it("never throws, even when publishDueArticles rejects — and logs the failure in the [scheduler] French convention", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    publishDueArticlesImpl = async () => {
      throw new Error("Erreur simulée (test).");
    };

    await expect(triggerScheduledPublishDue()).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes("[scheduler] échec de la publication planifiée") &&
          arg.includes("Erreur simulée (test)."),
      ),
    );
    expect(logged).toBe(true);
    errorSpy.mockRestore();
  });

  it("resolves and logs a French summary on success", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    publishDueArticlesImpl = async () => ({ published: 2, failed: 1 });

    await expect(triggerScheduledPublishDue()).resolves.toBeUndefined();

    const logged = logSpy.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes("[scheduler] publication planifiée: 2 publié(s), 1 échec(s)"),
      ),
    );
    expect(logged).toBe(true);
    logSpy.mockRestore();
  });
});
