// lib/ai/token-pool.ts — Task 3: server-only OpenRouter token pool loader. Reads active,
// non-cooldown rows from openrouter_tokens (db/schema.ts), decrypts each tokenCiphertext with
// lib/diffusion/crypto.ts's decryptSecret, and falls back to the single env-configured key
// (lib/config/pipeline-config.ts's `openrouter.apiKey`) when no DB rows apply. Plain module —
// NO "use server" — same reasoning as lib/diffusion/crypto.ts's header comment: decryptSecret must
// never be reachable from an unauthenticated Server Action entry point, and a decrypted secret
// must exist only inside a server-side call (here: the caller that actually hits OpenRouter).
import { asc, eq } from "drizzle-orm";
import { db, openrouterTokens } from "@/db";
import { decryptSecret } from "@/lib/diffusion/crypto";
import { getPipelineConfig, type PipelineConfig } from "@/lib/config/pipeline-config";

export type PooledToken = { id: string | null; label: string; token: string };

// État complet du pool, tel que le runner (lib/ai/with-token-pool.ts) a besoin de le lire pour
// distinguer DEUX situations que `tokens: []` confondait jusqu'ici :
//   • `configured: false` → RIEN n'est configuré (aucune ligne openrouter_tokens, quel que soit son
//     état, ET aucune clé d'environnement) : l'installation est vierge, l'utilisateur doit lire
//     « Aucun fournisseur IA configuré ».
//   • `configured: true` avec `tokens: []` → des jetons EXISTENT mais aucun n'est utilisable à cet
//     instant (tous désactivés et/ou en période de récupération) : anomalie temporaire bien réelle,
//     que l'utilisateur doit lire comme telle et non comme une absence de configuration.
// Cette distinction appartient au pool — lui seul voit les lignes en base. L'appelant la devinait
// auparavant depuis `cfg.openrouter`, ce qui se trompait précisément pour l'exploitant qui n'a
// saisi ses jetons que dans Réglages (sans OPENROUTER_API_KEY) et dont tout le parc est en cooldown.
export type OpenRouterPoolState = { tokens: PooledToken[]; configured: boolean };

// Charge l'état du pool en UNE seule requête : on lit TOUTES les lignes (le filtre
// actif/hors-cooldown est appliqué en mémoire juste après, la table compte au plus quelques
// dizaines de lignes) parce que `configured` a besoin de savoir si des lignes existent, y compris
// celles que le filtre SQL d'origine écartait. Ordre inchangé : sortOrder attribué par l'admin,
// puis createdAt comme départage stable. Une ligne dont le déchiffrement échoue (clé
// CREDENTIALS_ENCRYPTION_KEY tournée, données corrompues) est ignorée et non jetée — une mauvaise
// ligne ne doit jamais faire tomber tout le pool — mais elle compte quand même comme une
// configuration existante. La clé d'environnement (cfg.openrouter?.apiKey), si présente, est
// ajoutée en dernier comme membre de secours avec id:null (aucune ligne DB à mettre à jour pour
// markTokenResult) — sauf si son texte clair duplique un jeton déjà présent, ce qui gaspillerait
// une place dans la rotation.
export async function loadOpenRouterPoolState(cfg: PipelineConfig = getPipelineConfig()): Promise<OpenRouterPoolState> {
  const rows = await db
    .select()
    .from(openrouterTokens)
    .orderBy(asc(openrouterTokens.sortOrder), asc(openrouterTokens.createdAt));

  const now = Date.now();
  const tokens: PooledToken[] = [];
  for (const row of rows) {
    if (!row.active) continue;
    if (row.cooldownUntil !== null && row.cooldownUntil.getTime() > now) continue;
    try {
      tokens.push({ id: row.id, label: row.label, token: decryptSecret(row.tokenCiphertext) });
    } catch {
      console.warn("[token-pool] jeton indéchiffrable ignoré: " + row.id);
    }
  }

  const rawEnvKey = cfg.openrouter?.apiKey;
  const envKey = typeof rawEnvKey === "string" && rawEnvKey.length > 0 ? rawEnvKey : null;
  if (envKey !== null) {
    const alreadyPresent = tokens.some((t) => t.token === envKey);
    if (!alreadyPresent) tokens.push({ id: null, label: "environnement", token: envKey });
  }

  return { tokens, configured: rows.length > 0 || envKey !== null };
}

// Vue historique (jetons utilisables uniquement), conservée telle quelle pour les appelants qui
// n'ont que faire de la distinction ci-dessus — notamment lib/diffusion/caption.ts.
export async function getOpenRouterTokenPool(cfg: PipelineConfig = getPipelineConfig()): Promise<PooledToken[]> {
  return (await loadOpenRouterPoolState(cfg)).tokens;
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
