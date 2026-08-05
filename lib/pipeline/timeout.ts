// SP5 Task 2 — per-operation timeout: races `promise` against a timer of `ms` milliseconds so a
// stuck provider call (a hung fetch, a dead endpoint) can't make a pipeline run drag on for hours.
// On timeout, rejects with a French error naming the operation and the configured delay — this
// message becomes the failed step's errorMessage (via stages.ts' humanError), so an admin reading
// the run detail sees exactly which operation stalled and how long it was allowed to run.
//
// `ms` <= 0 (or non-finite, e.g. a malformed settings row) disables the timeout entirely — a guard
// so a misconfigured 0 can't instantly fail every operation in a run; the promise is simply awaited
// as-is. The timer is ALWAYS cleared (finally), so a promise that settles well before its timeout
// never leaves a dangling setTimeout holding the event loop open.
export async function withTimeout<T>(promise: Promise<T>, ms: number, opName: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`L'opération « ${opName} » a dépassé le délai de ${Math.round(ms / 1000)} s.`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
    // If `promise` itself eventually settles (resolves or rejects) AFTER the timeout already won
    // the race, nothing else is listening to it — swallow a late rejection so it never surfaces as
    // an unhandled rejection.
    promise.catch(() => {});
  }
}
