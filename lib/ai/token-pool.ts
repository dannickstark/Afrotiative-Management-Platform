// lib/ai/token-pool.ts — Task 3: server-only OpenRouter token pool loader. Reads active,
// non-cooldown rows from openrouter_tokens (db/schema.ts), decrypts each tokenCiphertext with
// lib/diffusion/crypto.ts's decryptSecret, and falls back to the single env-configured key
// (lib/config/pipeline-config.ts's `openrouter.apiKey`) when no DB rows apply. Plain module —
// NO "use server" — same reasoning as lib/diffusion/crypto.ts's header comment: decryptSecret must
// never be reachable from an unauthenticated Server Action entry point, and a decrypted secret
// must exist only inside a server-side call (here: the caller that actually hits OpenRouter).
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db, openrouterTokens } from "@/db";
import { decryptSecret } from "@/lib/diffusion/crypto";
import { getPipelineConfig, type PipelineConfig } from "@/lib/config/pipeline-config";

export type PooledToken = { id: string | null; label: string; token: string };

// Active + not-currently-cooling-down tokens, ordered by admin-assigned sortOrder then insertion
// order (createdAt) as a stable tiebreaker. A row whose ciphertext fails to decrypt (stale/rotated
// CREDENTIALS_ENCRYPTION_KEY, corrupted data) is skipped rather than thrown — one bad row must
// never take down the whole pool. The env-configured key (cfg.openrouter?.apiKey), if present, is
// appended last as a fallback with id:null (it has no DB row for markTokenResult to update) — unless
// its plaintext duplicates a DB token already in the pool, which would just waste a rotation slot.
export async function getOpenRouterTokenPool(cfg: PipelineConfig = getPipelineConfig()): Promise<PooledToken[]> {
  const rows = await db
    .select()
    .from(openrouterTokens)
    .where(and(eq(openrouterTokens.active, true), or(isNull(openrouterTokens.cooldownUntil), lte(openrouterTokens.cooldownUntil, new Date()))))
    .orderBy(asc(openrouterTokens.sortOrder), asc(openrouterTokens.createdAt));

  const pool: PooledToken[] = [];
  for (const row of rows) {
    try {
      pool.push({ id: row.id, label: row.label, token: decryptSecret(row.tokenCiphertext) });
    } catch {
      console.warn("[token-pool] jeton indéchiffrable ignoré: " + row.id);
    }
  }

  const envKey = cfg.openrouter?.apiKey;
  if (typeof envKey === "string" && envKey.length > 0) {
    const alreadyPresent = pool.some((t) => t.token === envKey);
    if (!alreadyPresent) pool.push({ id: null, label: "environnement", token: envKey });
  }

  return pool;
}

// Best-effort rotation bookkeeping — records the outcome of using a pooled token so the next
// getOpenRouterTokenPool() call can skip/deprioritize it. NEVER throws: a stats write failing here
// must not fail (or appear to fail) the LLM call that already succeeded or failed on its own terms.
// id:null (the env-fallback token) has no DB row to update, so it's a no-op.
export async function markTokenResult(id: string | null, status: string, cooldownMs?: number): Promise<void> {
  try {
    if (id === null) return;
    await db
      .update(openrouterTokens)
      .set({
        lastStatus: status,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
        lastError: status === "ok" ? null : status,
        ...(cooldownMs != null ? { cooldownUntil: new Date(Date.now() + cooldownMs) } : {}),
      })
      .where(eq(openrouterTokens.id, id));
  } catch (e) {
    console.warn("[token-pool] échec de l'enregistrement du résultat (ignoré): " + String(e));
  }
}
