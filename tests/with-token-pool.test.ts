import { describe, it, expect, mock } from "bun:test";
import type { PooledToken } from "@/lib/ai/token-pool";
import { runWithOpenRouterPool, RATE_LIMIT_COOLDOWN_MS, AUTH_COOLDOWN_MS, type PoolDeps } from "@/lib/ai/with-token-pool";

function tok(id: string, token: string): PooledToken {
  return { id, label: id, token };
}

function fakeDeps(pool: PooledToken[]): { deps: PoolDeps; markCalls: Array<[string | null, string, number | undefined]> } {
  const markCalls: Array<[string | null, string, number | undefined]> = [];
  const deps: PoolDeps = {
    loadPool: async () => pool,
    mark: async (id, status, cooldownMs) => {
      markCalls.push([id, status, cooldownMs]);
    },
  };
  return { deps, markCalls };
}

describe("runWithOpenRouterPool", () => {
  it("single token, op ok + not flaky → returns value, marks ok once, calls op once", async () => {
    const pool = [tok("t1", "key1")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async (apiKey: string) => `result:${apiKey}`);

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r).toEqual({ ok: true, value: "result:key1" });
    expect(opSpy).toHaveBeenCalledTimes(1);
    expect(markCalls).toEqual([["t1", "ok", undefined]]);
  });

  it("token1 flaky, token2 ok → returns token2's value; marks flaky (no cooldown) then ok; op called twice", async () => {
    const pool = [tok("t1", "key1"), tok("t2", "key2")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async (apiKey: string) => `result:${apiKey}`);
    const isFlaky = (v: string) => v === "result:key1";

    const r = await runWithOpenRouterPool(opSpy, isFlaky, deps);

    expect(r).toEqual({ ok: true, value: "result:key2" });
    expect(opSpy).toHaveBeenCalledTimes(2);
    expect(markCalls).toEqual([
      ["t1", "flaky", undefined],
      ["t2", "ok", undefined],
    ]);
  });

  it("token1 throws 429, token2 ok → marks rate_limited with cooldown then ok; returns token2", async () => {
    const pool = [tok("t1", "key1"), tok("t2", "key2")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async (apiKey: string) => {
      if (apiKey === "key1") throw { statusCode: 429 };
      return `result:${apiKey}`;
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r).toEqual({ ok: true, value: "result:key2" });
    expect(markCalls).toEqual([
      ["t1", "rate_limited", RATE_LIMIT_COOLDOWN_MS],
      ["t2", "ok", undefined],
    ]);
  });

  it("token1 throws 401 → marks auth_failed with cooldown, continues to token2", async () => {
    const pool = [tok("t1", "key1"), tok("t2", "key2")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async (apiKey: string) => {
      if (apiKey === "key1") throw { statusCode: 401 };
      return `result:${apiKey}`;
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r).toEqual({ ok: true, value: "result:key2" });
    expect(markCalls).toEqual([
      ["t1", "auth_failed", AUTH_COOLDOWN_MS],
      ["t2", "ok", undefined],
    ]);
  });

  it("all tokens flaky and/or throw → {ok:false}", async () => {
    const pool = [tok("t1", "key1"), tok("t2", "key2"), tok("t3", "key3")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async (apiKey: string) => {
      if (apiKey === "key2") throw new Error("boom");
      return `result:${apiKey}`; // key1 and key3 succeed but are flaky
    });

    const r = await runWithOpenRouterPool(opSpy, () => true, deps);

    expect(r).toEqual({ ok: false });
    expect(opSpy).toHaveBeenCalledTimes(3);
    expect(markCalls).toEqual([
      ["t1", "flaky", undefined],
      ["t2", "error", undefined],
      ["t3", "flaky", undefined],
    ]);
  });

  it("empty pool → {ok:false}, op never called", async () => {
    const { deps, markCalls } = fakeDeps([]);
    const opSpy = mock(async (apiKey: string) => `result:${apiKey}`);

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r).toEqual({ ok: false });
    expect(opSpy).not.toHaveBeenCalled();
    expect(markCalls).toEqual([]);
  });
});
