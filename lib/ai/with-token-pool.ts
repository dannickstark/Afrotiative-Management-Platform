// lib/ai/with-token-pool.ts — Task 4: shared rotation runner over the OpenRouter token pool
// (lib/ai/token-pool.ts). Given an operation `op(apiKey) => Promise<T>` and a caller-supplied
// `isFlaky(value)` predicate (a call that "succeeded" transport-wise but produced unusable output,
// e.g. empty/garbage content), walks the pool in order, retrying the NEXT token on flaky results or
// on any classified failure, and records the outcome via markTokenResult so the pool's ordering /
// cooldowns reflect real-world behavior. Server-only (decryptSecret lives behind getOpenRouterTokenPool)
// but this file itself touches no DB/crypto directly — no "use server" needed.
//
// Pure/injectable by design: `deps` defaults to the real pool + real markTokenResult, but tests pass
// a fake `deps` (in-memory pool array + a spy `mark`) so the rotation/backoff logic can be verified
// with zero DB or network access — see tests/with-token-pool.test.ts.
import { getOpenRouterTokenPool, markTokenResult, type PooledToken } from "./token-pool";
import { classifyOpenRouterError } from "./openrouter-errors";

const RATE_LIMIT_COOLDOWN_MS = (Number(process.env.OPENROUTER_RATE_COOLDOWN_MIN) || 60) * 60_000;
const AUTH_COOLDOWN_MS = 24 * 60 * 60_000; // a bad key won't fix itself soon

export type PoolResult<T> = { ok: true; value: T } | { ok: false };

// deps injectable for tests
export type PoolDeps = {
  loadPool: () => Promise<PooledToken[]>;
  mark: (id: string | null, status: string, cooldownMs?: number) => Promise<void>;
};

export async function runWithOpenRouterPool<T>(
  op: (apiKey: string) => Promise<T>,
  isFlaky: (result: T) => boolean,
  deps: PoolDeps = { loadPool: () => getOpenRouterTokenPool(), mark: markTokenResult },
): Promise<PoolResult<T>> {
  const pool = await deps.loadPool();
  for (const t of pool) {
    try {
      const value = await op(t.token);
      if (isFlaky(value)) {
        await deps.mark(t.id, "flaky");
        continue;
      }
      await deps.mark(t.id, "ok");
      return { ok: true, value };
    } catch (e) {
      const kind = classifyOpenRouterError(e);
      if (kind === "rate_limited") await deps.mark(t.id, "rate_limited", RATE_LIMIT_COOLDOWN_MS);
      else if (kind === "auth_failed") await deps.mark(t.id, "auth_failed", AUTH_COOLDOWN_MS);
      else await deps.mark(t.id, "error");
      continue;
    }
  }
  return { ok: false };
}

export { RATE_LIMIT_COOLDOWN_MS, AUTH_COOLDOWN_MS };
