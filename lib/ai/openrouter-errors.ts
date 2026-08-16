import { APICallError, NoObjectGeneratedError } from "ai";

/**
 * Classify an error thrown by the AI SDK / OpenRouter into a small set of
 * buckets the token-pool logic can react to.
 *
 * - "no_object": generateObject got a real answer from the provider but the model
 *   failed to produce parsable/schema-conforming JSON. The KEY worked — rotating to
 *   another token would replay the exact same request and fail the exact same way,
 *   so the pool must stop instead of burning the rest of the fleet.
 * - "rate_limited": HTTP 429, or a message indicating rate limiting, quota
 *   exhaustion, or no available endpoints — these should trigger token
 *   rotation / backoff.
 * - "auth_failed": HTTP 401/403 — the token itself is bad.
 * - "error": anything else (including non-APICallError throws).
 */
export function classifyOpenRouterError(err: unknown): "no_object" | "rate_limited" | "auth_failed" | "error" {
  // Testé EN PREMIER et sur le TYPE d'erreur (marqueur interne du SDK), jamais sur le texte : un
  // modèle peut recopier n'importe quel mot — « quota », « rate limit » — dans le brouillon qu'il
  // n'a pas su structurer, et une lecture par mots-clés relancerait alors toute la rotation sur un
  // échec qui n'a rien à voir avec les jetons. Réciproquement, un objet nu imitant le message n'est
  // pas classé ici : seul le vrai jet de generateObject compte.
  if (NoObjectGeneratedError.isInstance(err)) return "no_object";

  const status = APICallError.isInstance(err) ? err.statusCode : (err as any)?.statusCode;
  const msg = String((err as any)?.message ?? err ?? "");

  if (status === 429 || /rate.?limit|quota|exhaust|insufficient|no endpoints/i.test(msg)) {
    return "rate_limited";
  }
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  return "error";
}
