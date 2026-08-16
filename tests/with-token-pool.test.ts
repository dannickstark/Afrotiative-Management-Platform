import { describe, it, expect, mock } from "bun:test";
import type { PooledToken } from "@/lib/ai/token-pool";
import {
  runWithOpenRouterPool,
  RATE_LIMIT_COOLDOWN_MS,
  AUTH_COOLDOWN_MS,
  ATTEMPTS_PER_TOKEN,
  type PoolDeps,
} from "@/lib/ai/with-token-pool";

function tok(id: string, token: string): PooledToken {
  return { id, label: id, token };
}

// `configured` par défaut = « il existe au moins un jeton » : c'est le cas de tous les scénarios de
// rotation ci-dessous, où le pool est justement non vide. Les deux scénarios de pool VIDE le
// passent explicitement, puisque c'est ce drapeau — et non une déduction de l'appelant à partir de
// cfg.openrouter — qui distingue « rien de configuré » de « tout est en récupération ».
function fakeDeps(
  pool: PooledToken[],
  configured: boolean = pool.length > 0,
): { deps: PoolDeps; markCalls: Array<[string | null, string, number | undefined]> } {
  const markCalls: Array<[string | null, string, number | undefined]> = [];
  const deps: PoolDeps = {
    loadPool: async () => ({ tokens: pool, configured }),
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

  it("pool vide alors que des jetons EXISTENT (tous inactifs ou en récupération) → reason 'empty_pool'", async () => {
    // Le cas exact que ce correctif vise : un exploitant n'ayant saisi ses jetons que dans Réglages
    // (donc sans OPENROUTER_API_KEY) et dont tout le parc est en cooldown. `configured: true` dit
    // « une configuration existe » — l'utilisateur doit lire le message « jetons indisponibles »,
    // surtout pas « aucun fournisseur configuré ».
    const { deps, markCalls } = fakeDeps([], true);
    const opSpy = mock(async (apiKey: string) => `result:${apiKey}`);

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r).toEqual({ ok: false, reason: "empty_pool" });
    expect(opSpy).not.toHaveBeenCalled();
    expect(markCalls).toEqual([]);
  });

  it("pool vide ET aucune configuration → reason 'unconfigured', op jamais appelé", async () => {
    // Installation vierge : aucune ligne openrouter_tokens, aucune clé d'environnement.
    const { deps, markCalls } = fakeDeps([], false);
    const opSpy = mock(async (apiKey: string) => `result:${apiKey}`);

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r).toEqual({ ok: false, reason: "unconfigured" });
    expect(opSpy).not.toHaveBeenCalled();
    expect(markCalls).toEqual([]);
  });

  it("1 jeton, 1er essai flaky, 2e essai bon → ok:true, op appelé 2 fois, mark une seule fois avec ok", async () => {
    const pool = [tok("t1", "key1")];
    const { deps, markCalls } = fakeDeps(pool);
    let calls = 0;
    const opSpy = mock(async (apiKey: string) => {
      calls += 1;
      return calls === 1 ? "flaky-value" : "good-value";
    });
    const isFlaky = (v: string) => v === "flaky-value";

    const r = await runWithOpenRouterPool(opSpy, isFlaky, deps);

    expect(r).toEqual({ ok: true, value: "good-value" });
    expect(opSpy).toHaveBeenCalledTimes(2);
    expect(markCalls).toEqual([["t1", "ok", undefined]]);
  });

  it("1 jeton, 2 essais flaky → ok:false reason flaky, un seul mark(t1, flaky)", async () => {
    const pool = [tok("t1", "key1")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async () => "flaky-value");
    const isFlaky = () => true;

    const r = await runWithOpenRouterPool(opSpy, isFlaky, deps);

    expect(r).toEqual({ ok: false, reason: "flaky" });
    expect(opSpy).toHaveBeenCalledTimes(2);
    expect(markCalls).toEqual([["t1", "flaky", undefined]]);
  });

  it("1 jeton, 1er essai jette une erreur générique, 2e essai bon → ok:true, un seul mark(t1, ok)", async () => {
    const pool = [tok("t1", "key1")];
    const { deps, markCalls } = fakeDeps(pool);
    let calls = 0;
    const opSpy = mock(async (apiKey: string) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return `result:${apiKey}`;
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r).toEqual({ ok: true, value: "result:key1" });
    expect(opSpy).toHaveBeenCalledTimes(2);
    expect(markCalls).toEqual([["t1", "ok", undefined]]);
  });

  it("1 jeton qui jette 429 → op appelé une seule fois (pas de réessai), mark rate_limited avec cooldown", async () => {
    const pool = [tok("t1", "key1")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async () => {
      throw { statusCode: 429 };
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(opSpy).toHaveBeenCalledTimes(1);
    expect(markCalls).toEqual([["t1", "rate_limited", RATE_LIMIT_COOLDOWN_MS]]);
    expect(r).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("1 jeton qui jette 401 → op appelé une seule fois, mark auth_failed avec cooldown", async () => {
    const pool = [tok("t1", "key1")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async () => {
      throw { statusCode: 401 };
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(opSpy).toHaveBeenCalledTimes(1);
    expect(markCalls).toEqual([["t1", "auth_failed", AUTH_COOLDOWN_MS]]);
    expect(r).toMatchObject({ ok: false, reason: "auth_failed" });
  });

  it("2 jetons: t1 tout-flaky, t2 429 → reason rate_limited (priorité), detail porte le message du 429", async () => {
    const pool = [tok("t1", "key1"), tok("t2", "key2")];
    const { deps, markCalls } = fakeDeps(pool);
    const opSpy = mock(async (apiKey: string) => {
      if (apiKey === "key1") return "flaky-value";
      throw { statusCode: 429, message: "429 Too Many Requests" };
    });
    const isFlaky = (v: string) => v === "flaky-value";

    const r = await runWithOpenRouterPool(opSpy, isFlaky, deps);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("rate_limited");
      expect(r.detail).toContain("429 Too Many Requests");
    }
    expect(markCalls).toEqual([
      ["t1", "flaky", undefined],
      ["t2", "rate_limited", RATE_LIMIT_COOLDOWN_MS],
    ]);
  });

  it("2 jetons: t1 429, t2 ok → inchangé (ok:true, cooldown posé sur t1)", async () => {
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

  it("detail est tronqué à 200 caractères sur un message d'erreur très long", async () => {
    const pool = [tok("t1", "key1")];
    const { deps } = fakeDeps(pool);
    const longMessage = "x".repeat(500);
    const opSpy = mock(async () => {
      throw new Error(longMessage);
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("error");
      expect(r.detail).toBeDefined();
      expect(r.detail!.length).toBeLessThanOrEqual(200);
    }
  });

  it("une sous-chaîne en forme de clé dans le message d'erreur est caviardée dans `detail`", async () => {
    // Un fournisseur (ou un proxy en amont) peut recopier la clé refusée dans son message d'erreur ;
    // `detail` finissant dans une phrase affichée à l'utilisateur, aucun fragment de jeton ne doit
    // survivre — voir la rédaction appliquée par lib/ai/detail.ts.
    const pool = [tok("t1", "sk-or-v1-abcdef0123456789")];
    const { deps } = fakeDeps(pool);
    const opSpy = mock(async () => {
      throw new Error("401 Unauthorized: invalid key sk-or-v1-abcdef0123456789 rejected");
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toBeDefined();
      expect(r.detail).not.toContain("abcdef0123456789");
      expect(r.detail).toContain("sk-***");
      expect(r.detail).toContain("401 Unauthorized");
    }
  });

  it("une clé de forme réelle (sk-or-v1- + longue suite hexadécimale) est caviardée", async () => {
    // Forme réellement émise par OpenRouter : préfixe sk-or-v1- suivi d'une longue suite continue.
    const realShapedKey = "sk-or-v1-" + "0123456789abcdef".repeat(4);
    const { deps } = fakeDeps([tok("t1", "key1")]);
    const opSpy = mock(async () => {
      throw new Error(`401 Unauthorized: key ${realShapedKey} is disabled`);
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toBe("401 Unauthorized: key sk-*** is disabled");
      expect(r.detail).not.toContain("0123456789abcdef");
    }
  });

  it("un mot composé anodin commençant par « sk- » n'est PAS caviardé", async () => {
    // Le tiret ne fait plus partie de la suite reconnue comme clé : un identifiant de modèle ou un
    // mot technique tirété survit intact, là où l'ancien motif avalait toute la fin du message.
    const { deps } = fakeDeps([tok("t1", "key1")]);
    const opSpy = mock(async () => {
      throw new Error("unknown model sk-preview-experimental not found");
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe("unknown model sk-preview-experimental not found");
  });

  it("un objet jeté non-`Error` porteur d'un .message alimente quand même `detail`", async () => {
    // Sémantique tolérante retenue comme unique implémentation dans lib/ai/detail.ts : les SDK
    // fournisseurs jettent volontiers des objets nus `{ statusCode, message }`.
    const pool = [tok("t1", "key1")];
    const { deps } = fakeDeps(pool);
    const opSpy = mock(async () => {
      throw { statusCode: 500, message: "upstream indisponible" };
    });

    const r = await runWithOpenRouterPool(opSpy, () => false, deps);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe("upstream indisponible");
  });

  it("ATTEMPTS_PER_TOKEN vaut 2", () => {
    expect(ATTEMPTS_PER_TOKEN).toBe(2);
  });
});
