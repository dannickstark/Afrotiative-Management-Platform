// lib/ai/with-token-pool.ts — Task 4: shared rotation runner over the OpenRouter token pool
// (lib/ai/token-pool.ts). Given an operation `op(apiKey) => Promise<T>` and a caller-supplied
// `isFlaky(value)` predicate (a call that "succeeded" transport-wise but produced unusable output,
// e.g. empty/garbage content), walks the pool in order, retrying the NEXT token on flaky results or
// on any classified failure, and records the outcome via markTokenResult so the pool's ordering /
// cooldowns reflect real-world behavior. Server-only (decryptSecret lives behind getOpenRouterTokenPool)
// but this file itself touches no DB/crypto directly — no "use server" needed.
//
// Pure/injectable by design: `deps` defaults to the real pool state + real markTokenResult, but
// tests pass a fake `deps` (in-memory { tokens, configured } state + a spy `mark`) so the
// rotation/backoff logic — and the unconfigured/empty_pool distinction — can be verified with zero
// DB or network access — see tests/with-token-pool.test.ts.
import { loadOpenRouterPoolState, markTokenResult, type OpenRouterPoolState } from "./token-pool";
import { classifyOpenRouterError } from "./openrouter-errors";
import { truncateDetail } from "./detail";

const RATE_LIMIT_COOLDOWN_MS = (Number(process.env.OPENROUTER_RATE_COOLDOWN_MIN) || 60) * 60_000;
const AUTH_COOLDOWN_MS = 24 * 60 * 60_000; // a bad key won't fix itself soon

// Nombre de tentatives accordées à CHAQUE jeton avant de passer au suivant. Ne s'applique qu'aux
// échecs qui peuvent raisonnablement réussir au 2e essai (brouillon flaky, erreur non classée) —
// pas aux échecs de transport définitifs sur ce jeton (rate_limited, auth_failed), voir la boucle.
export const ATTEMPTS_PER_TOKEN = 2;

// Raison d'échec renvoyée quand le pool entier a été épuisé sans succès. `unconfigured` et
// `empty_pool` sont deux cas à part (aucun jeton essayé), distingués par `OpenRouterPoolState.
// configured` (lib/ai/token-pool.ts) : rien de configuré du tout d'un côté, jetons existants mais
// tous indisponibles de l'autre. Les autres valeurs sont agrégées sur tous les jetons essayés, par
// ordre de priorité décroissante — c'est l'ordre de ce que l'utilisateur peut faire : attendre,
// corriger une clé, regarder les logs, ou juste relancer.
export type PoolFailureReason = "unconfigured" | "empty_pool" | "rate_limited" | "auth_failed" | "flaky" | "error";

// Raisons issues d'un jeton RÉELLEMENT essayé (les deux cas « pool inutilisable » en sont exclus).
type TriedTokenReason = Exclude<PoolFailureReason, "empty_pool" | "unconfigured">;

const REASON_PRIORITY: TriedTokenReason[] = ["rate_limited", "auth_failed", "error", "flaky"];

export type PoolResult<T> = { ok: true; value: T } | { ok: false; reason: PoolFailureReason; detail?: string };

// deps injectable for tests — `loadPool` renvoie l'ÉTAT du pool (jetons + `configured`), pas
// seulement la liste des jetons : c'est ce signal qui permet de distinguer `unconfigured` de
// `empty_pool`, et les tests le simulent exactement comme le reste des deps.
export type PoolDeps = {
  loadPool: () => Promise<OpenRouterPoolState>;
  mark: (id: string | null, status: string, cooldownMs?: number) => Promise<void>;
};

export async function runWithOpenRouterPool<T>(
  op: (apiKey: string) => Promise<T>,
  isFlaky: (result: T) => boolean,
  deps: PoolDeps = { loadPool: () => loadOpenRouterPoolState(), mark: markTokenResult },
): Promise<PoolResult<T>> {
  const { tokens: pool, configured } = await deps.loadPool();
  if (pool.length === 0) {
    // Cas désormais RÉELLEMENT atteignable en production : les générateurs appellent ce runner sans
    // plus exiger OPENROUTER_API_KEY (voir generate-article.ts / improve-article.ts), donc on arrive
    // ici dès qu'aucun jeton utilisable n'est disponible. Le pool lui-même tranche entre les deux
    // situations (voir OpenRouterPoolState) : `configured: false` = installation vierge, à signaler
    // comme telle ; `configured: true` = des jetons existent mais dorment tous (désactivés et/ou en
    // récupération), ce que l'utilisateur doit lire précisément, y compris — et surtout — quand ses
    // jetons ne viennent que de Réglages, sans clé d'environnement.
    if (!configured) {
      console.warn("[openrouter] aucune configuration OpenRouter — ni jeton en base ni clé d'environnement");
      return { ok: false, reason: "unconfigured" };
    }
    console.warn("[openrouter] pool vide — des jetons existent mais aucun n'est actif hors période de récupération");
    return { ok: false, reason: "empty_pool" };
  }

  // Raisons rencontrées sur ce passage du pool (une par jeton, son issue finale), pour l'agrégation
  // de fin de boucle si aucun jeton n'aboutit.
  const seenReasons: TriedTokenReason[] = [];
  let lastDetail: string | undefined;

  for (const t of pool) {
    let attempt = 0;
    let tokenSettled = false;

    while (!tokenSettled) {
      attempt += 1;
      try {
        const value = await op(t.token);
        if (isFlaky(value)) {
          console.warn(`[openrouter] jeton « ${t.label} » — brouillon inexploitable (flaky), tentative ${attempt}/${ATTEMPTS_PER_TOKEN}`);
          if (attempt < ATTEMPTS_PER_TOKEN) continue; // réessai du même jeton
          await deps.mark(t.id, "flaky");
          seenReasons.push("flaky");
          tokenSettled = true;
          break;
        }
        await deps.mark(t.id, "ok");
        return { ok: true, value };
      } catch (e) {
        const kind = classifyOpenRouterError(e);
        const detail = truncateDetail(e);
        console.warn(`[openrouter] jeton « ${t.label} » — ${kind} (tentative ${attempt}/${ATTEMPTS_PER_TOKEN})${detail ? ` : ${detail}` : ""}`);

        if (kind === "rate_limited" || kind === "auth_failed") {
          // Échec de transport définitif sur ce jeton — aucun réessai, inutile.
          const cooldown = kind === "rate_limited" ? RATE_LIMIT_COOLDOWN_MS : AUTH_COOLDOWN_MS;
          await deps.mark(t.id, kind, cooldown);
          seenReasons.push(kind);
          lastDetail = detail ?? lastDetail;
          tokenSettled = true;
          break;
        }

        // kind === "error" : peut passer au 2e essai.
        if (attempt < ATTEMPTS_PER_TOKEN) continue;
        await deps.mark(t.id, "error");
        seenReasons.push("error");
        lastDetail = detail ?? lastDetail;
        tokenSettled = true;
        break;
      }
    }
  }

  const reason = aggregateReason(seenReasons);
  console.warn(`[openrouter] pool épuisé — ${pool.length} jeton(s) essayé(s), raison retenue : ${reason}`);
  return lastDetail !== undefined ? { ok: false, reason, detail: lastDetail } : { ok: false, reason };
}

function aggregateReason(reasons: TriedTokenReason[]): PoolFailureReason {
  for (const candidate of REASON_PRIORITY) {
    if (reasons.includes(candidate)) return candidate;
  }
  return "error"; // ne devrait pas arriver (au moins une raison est toujours poussée par jeton)
}

export { RATE_LIMIT_COOLDOWN_MS, AUTH_COOLDOWN_MS };
