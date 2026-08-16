// lib/ai/detail.ts — module PUR (aucune dépendance DB/réseau/`"use server"`) : normalise le message
// d'une exception fournisseur en un `detail` sûr à faire remonter jusqu'à l'utilisateur
// (lib/ai/failure-message.ts l'interpole tel quel dans la phrase affichée).
//
// Implémentation UNIQUE, partagée par les trois appelants qui en avaient chacun une copie —
// lib/ai/with-token-pool.ts, lib/ai/generate-article.ts et lib/ai/improve-article.ts — dont deux
// avaient déjà divergé (elles renvoyaient `undefined` pour un objet jeté non-`Error` porteur d'un
// `.message`, là où le pool le lisait). C'est la sémantique TOLÉRANTE du pool qui fait foi ici :
// les SDK fournisseurs jettent volontiers des objets nus `{ statusCode, message }`, et perdre leur
// message reviendrait à afficher « Appel à l'IA en échec » sans la moindre piste.
export const DETAIL_MAX_LENGTH = 200;

// Rédaction défensive : un message d'erreur fournisseur (ou d'un proxy en amont) peut recopier la
// clé qui vient d'être refusée. Ce message finit dans une chaîne affichée à l'utilisateur et dans
// les journaux — un jeton, même partiel, ne doit JAMAIS y apparaître. On neutralise donc toute
// sous-chaîne en forme de clé OpenRouter/OpenAI AVANT la troncature (tronquer d'abord pourrait
// laisser passer un fragment de clé coupé en deux).
const KEY_LIKE_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;
const KEY_REDACTION = "sk-***";

export function truncateDetail(e: unknown): string | undefined {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : (e as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const redacted = raw.replace(KEY_LIKE_PATTERN, KEY_REDACTION);
  return redacted.length > DETAIL_MAX_LENGTH ? redacted.slice(0, DETAIL_MAX_LENGTH) : redacted;
}
