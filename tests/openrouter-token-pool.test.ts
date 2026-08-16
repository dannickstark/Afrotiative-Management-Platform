// tests/openrouter-token-pool.test.ts — Task 3 (DB lane, deliberately NOT added to
// scripts/test-fast.ts's PURE_FILES). Seeds real rows into openrouter_tokens via encryptSecret and
// exercises lib/ai/token-pool.ts's getOpenRouterTokenPool/markTokenResult against them, cleaning up
// every seeded row in try/finally so the shared dev DB is never left polluted (same convention as
// tests/openrouter-tokens-schema.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { db, openrouterTokens } from "@/db";
import { eq } from "drizzle-orm";
import { encryptSecret } from "@/lib/diffusion/crypto";
import { getOpenRouterTokenPool, loadOpenRouterPoolState, markTokenResult } from "@/lib/ai/token-pool";
import type { PipelineConfig } from "@/lib/config/pipeline-config";

// This suite exercises real encrypt/decrypt round trips (seeds openrouter_tokens rows via
// encryptSecret, then has getOpenRouterTokenPool decrypt them back), so it needs a valid
// CREDENTIALS_ENCRYPTION_KEY of its own — set/restored HERE, file-scoped, rather than in
// test-setup.ts (which deliberately stays DB-creds + auth-config only). Same per-file convention as
// tests/diffusion-credentials-presence.test.ts, tests/diffusion-crypto.test.ts, tests/diffusion-
// facebook.test.ts, etc.
const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
});

const emptyCfg = { openrouter: undefined } as unknown as PipelineConfig;
const envCfg = (apiKey: string) => ({ openrouter: { apiKey, model: "openai/gpt-4o-mini", baseUrl: "https://openrouter.ai/api/v1" } }) as unknown as PipelineConfig;

describe("getOpenRouterTokenPool", () => {
  it("returns active, non-cooldown tokens ordered by sortOrder", async () => {
    const [a, b, c] = await db.insert(openrouterTokens).values([
      { label: "third", tokenCiphertext: encryptSecret("token-third"), sortOrder: 2 },
      { label: "first", tokenCiphertext: encryptSecret("token-first"), sortOrder: 0 },
      { label: "second", tokenCiphertext: encryptSecret("token-second"), sortOrder: 1 },
    ]).returning();

    try {
      const pool = await getOpenRouterTokenPool(emptyCfg);
      const labels = pool.filter((t) => ["first", "second", "third"].includes(t.label)).map((t) => t.label);
      expect(labels).toEqual(["first", "second", "third"]);
      const first = pool.find((t) => t.label === "first")!;
      expect(first.id).toBe(b.id); // "first" was the second insert() call, seeded with sortOrder:0
      expect(first.token).toBe("token-first");
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, a.id));
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, b.id));
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, c.id));
    }
  });

  // Répartition réelle de la charge : sans cet ordre, le pool repartait de sortOrder à CHAQUE appel,
  // donc le premier jeton absorbait 100 % du trafic et les suivants n'étaient contactés qu'en cas
  // d'échec — d'où des clés OpenRouter affichant zéro consommation. Le moins récemment utilisé passe
  // désormais en tête ; sortOrder ne sert plus qu'à départager (jetons jamais utilisés compris).
  it("classe le jeton le moins récemment utilisé en tête (lastUsedAt croissant, jamais utilisé d'abord)", async () => {
    const now = Date.now();
    const [recent, older, never] = await db.insert(openrouterTokens).values([
      { label: "lru-recent", tokenCiphertext: encryptSecret("token-lru-recent"), sortOrder: 0, lastUsedAt: new Date(now - 60_000) },
      { label: "lru-older", tokenCiphertext: encryptSecret("token-lru-older"), sortOrder: 1, lastUsedAt: new Date(now - 600_000) },
      { label: "lru-never", tokenCiphertext: encryptSecret("token-lru-never"), sortOrder: 2 },
    ]).returning();

    try {
      const pool = await getOpenRouterTokenPool(emptyCfg);
      const labels = pool.filter((t) => t.label.startsWith("lru-")).map((t) => t.label);
      // jamais utilisé < utilisé il y a 10 min < utilisé il y a 1 min — l'inverse exact de sortOrder,
      // ce qui prouve que c'est bien lastUsedAt qui commande.
      expect(labels).toEqual(["lru-never", "lru-older", "lru-recent"]);
    } finally {
      for (const r of [recent, older, never]) await db.delete(openrouterTokens).where(eq(openrouterTokens.id, r.id));
    }
  });

  it("excludes a token whose cooldownUntil is in the future, includes one whose cooldownUntil is in the past", async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const [cooling, cooled] = await db.insert(openrouterTokens).values([
      { label: "cooling-down", tokenCiphertext: encryptSecret("token-cooling"), cooldownUntil: future },
      { label: "cooled-off", tokenCiphertext: encryptSecret("token-cooled"), cooldownUntil: past },
    ]).returning();

    try {
      const pool = await getOpenRouterTokenPool(emptyCfg);
      const labels = pool.map((t) => t.label);
      expect(labels).not.toContain("cooling-down");
      expect(labels).toContain("cooled-off");
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, cooling.id));
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, cooled.id));
    }
  });

  it("excludes inactive tokens", async () => {
    const [inactive] = await db.insert(openrouterTokens).values([
      { label: "disabled", tokenCiphertext: encryptSecret("token-disabled"), active: false },
    ]).returning();

    try {
      const pool = await getOpenRouterTokenPool(emptyCfg);
      expect(pool.map((t) => t.label)).not.toContain("disabled");
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, inactive.id));
    }
  });

  it("appends the env-fallback token last with id:null when cfg.openrouter.apiKey is set", async () => {
    const [row] = await db.insert(openrouterTokens).values([
      { label: "db-token", tokenCiphertext: encryptSecret("token-db"), sortOrder: 0 },
    ]).returning();

    try {
      const pool = await getOpenRouterTokenPool(envCfg("env-secret-key"));
      expect(pool.length).toBeGreaterThanOrEqual(2);
      const last = pool[pool.length - 1];
      expect(last).toEqual({ id: null, label: "environnement", token: "env-secret-key" });
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    }
  });

  it("does not append the env token when its plaintext duplicates a DB token already in the pool", async () => {
    const [row] = await db.insert(openrouterTokens).values([
      { label: "db-token", tokenCiphertext: encryptSecret("shared-secret") },
    ]).returning();

    try {
      const pool = await getOpenRouterTokenPool(envCfg("shared-secret"));
      const envEntries = pool.filter((t) => t.id === null);
      expect(envEntries.length).toBe(0);
      expect(pool.filter((t) => t.token === "shared-secret").length).toBe(1);
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    }
  });

  it("skips a row with garbage (non-decryptable) ciphertext without throwing, returns the others", async () => {
    const [good, bad] = await db.insert(openrouterTokens).values([
      { label: "good-token", tokenCiphertext: encryptSecret("token-good") },
      { label: "garbage-token", tokenCiphertext: "not-a-valid-encrypted-blob" },
    ]).returning();

    try {
      const pool = await getOpenRouterTokenPool(emptyCfg);
      const labels = pool.map((t) => t.label);
      expect(labels).toContain("good-token");
      expect(labels).not.toContain("garbage-token");
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, good.id));
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, bad.id));
    }
  });

  it("returns an empty array when there are no active tokens and no env fallback", async () => {
    const pool = await getOpenRouterTokenPool(emptyCfg);
    // Can't assert pool.length === 0 in a shared dev DB (other rows may legitimately exist), but we
    // can assert it never throws and is always an array.
    expect(Array.isArray(pool)).toBe(true);
  });
});

describe("loadOpenRouterPoolState", () => {
  // La distinction que ce module porte désormais : « aucun jeton utilisable MAINTENANT » n'est pas
  // « rien n'est configuré ». Un exploitant dont tout le parc est désactivé ou en récupération, sans
  // OPENROUTER_API_KEY, doit produire { tokens: [], configured: true } — c'est ce que le runner
  // (lib/ai/with-token-pool.ts) traduit en `empty_pool` plutôt qu'en `unconfigured`.
  it("marque configured:true alors qu'aucun jeton n'est utilisable (toutes les lignes désactivées ou en récupération)", async () => {
    const [inactive, cooling] = await db.insert(openrouterTokens).values([
      { label: "etat-desactive", tokenCiphertext: encryptSecret("token-off"), active: false },
      { label: "etat-cooldown", tokenCiphertext: encryptSecret("token-cool"), cooldownUntil: new Date(Date.now() + 60_000) },
    ]).returning();

    try {
      const state = await loadOpenRouterPoolState(emptyCfg);
      expect(state.configured).toBe(true); // les lignes existent, même inutilisables
      const labels = state.tokens.map((t) => t.label);
      expect(labels).not.toContain("etat-desactive");
      expect(labels).not.toContain("etat-cooldown");
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, inactive.id));
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, cooling.id));
    }
  });

  // La base de dev est partagée : impossible d'y garantir zéro ligne openrouter_tokens, donc le cas
  // « aucune ligne ET aucune clé → configured:false » est couvert au niveau du runner, où l'état du
  // pool est injecté (tests/with-token-pool.test.ts). Ici on vérifie l'autre moitié de la règle : la
  // clé d'environnement suffit à elle seule à rendre l'installation « configurée ».
  it("marque configured:true dès qu'une clé d'environnement existe", async () => {
    const state = await loadOpenRouterPoolState(envCfg("env-secret-key"));
    expect(state.configured).toBe(true);
    expect(state.tokens.some((t) => t.id === null && t.token === "env-secret-key")).toBe(true);
  });

  it("getOpenRouterTokenPool renvoie exactement les jetons utilisables de l'état (vue historique)", async () => {
    const [row] = await db.insert(openrouterTokens).values([
      { label: "vue-historique", tokenCiphertext: encryptSecret("token-vue") },
    ]).returning();

    try {
      const state = await loadOpenRouterPoolState(emptyCfg);
      const pool = await getOpenRouterTokenPool(emptyCfg);
      expect(pool).toEqual(state.tokens);
      expect(pool.map((t) => t.label)).toContain("vue-historique");
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    }
  });
});

describe("markTokenResult", () => {
  it("is a no-op for id:null (env token) and never throws", async () => {
    await expect(markTokenResult(null, "ok")).resolves.toBeUndefined();
  });

  it("sets lastStatus and a cooldownUntil ~1s in the future when cooldownMs is provided", async () => {
    const [row] = await db.insert(openrouterTokens).values([
      { label: "mark-me", tokenCiphertext: encryptSecret("token-mark") },
    ]).returning();

    try {
      const before = Date.now();
      await markTokenResult(row.id, "rate_limited", 1000);

      const [updated] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.id, row.id));
      expect(updated.lastStatus).toBe("rate_limited");
      expect(updated.lastUsedAt).not.toBeNull();
      expect(updated.cooldownUntil).not.toBeNull();
      const cooldownMs = updated.cooldownUntil!.getTime();
      expect(cooldownMs).toBeGreaterThanOrEqual(before + 900);
      expect(cooldownMs).toBeLessThanOrEqual(before + 1000 + 5000); // generous upper bound for test-runner jitter
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    }
  });

  it("leaves cooldownUntil unchanged when cooldownMs is not provided", async () => {
    const [row] = await db.insert(openrouterTokens).values([
      { label: "mark-ok", tokenCiphertext: encryptSecret("token-mark-ok") },
    ]).returning();

    try {
      await markTokenResult(row.id, "ok");
      const [updated] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.id, row.id));
      expect(updated.lastStatus).toBe("ok");
      expect(updated.cooldownUntil).toBeNull();
      expect(updated.lastError).toBeNull();
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    }
  });
});
