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
// sous-chaîne en forme de clé (OpenRouter, OpenAI classique/projet/service-account/admin) AVANT la
// troncature (tronquer d'abord pourrait laisser passer un fragment de clé coupé en deux).
//
// Historique de ce motif, pour éviter de le re-casser dans un sens ou dans l'autre :
//   1) une première version interdisait le tiret dans le corps de la clé → elle mangeait « unknown
//      model sk-preview-experimental not found » en entier (le tiret servait de simple liant dans
//      un mot composé anodin) ;
//   2) le correctif suivant a donc EXCLU le tiret du corps reconnu comme clé — mais ça a rouvert un
//      trou : `sk-proj-…` (clés de projet OpenAI, encodées en base64url) contient légitimement des
//      `-`/`_` tôt dans le corps, et ces vraies clés traversaient alors non caviardées.
//
// Le signal qui permet de distinguer les deux SANS réintroduire le premier bug : une vraie clé
// contient au moins un CHIFFRE quelque part dans sa longue suite continue, alors qu'un mot composé
// anodin (« preview-experimental », etc.) n'en contient jamais. On autorise donc `-` et `_` dans le
// corps reconnu (pour couvrir base64url), mais on n'accepte le caviardage que si ce corps contient
// au moins un chiffre — d'où les deux lookaheads : l'un vérifie la longueur minimale (16, très en
// dessous des dizaines de caractères d'une vraie clé), l'autre exige la présence d'un chiffre.
// Si un jour ce motif est retouché : NE PAS ré-exclure le tiret du corps (ça recasse `sk-proj-…`),
// et NE PAS retirer l'exigence de chiffre (ça recasse « sk-preview-experimental »).
const KEY_LIKE_PATTERN =
  /sk-(?:or-v1-|proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]{16,})(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g;
const KEY_REDACTION = "sk-***";

export function truncateDetail(e: unknown): string | undefined {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : (e as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const redacted = raw.replace(KEY_LIKE_PATTERN, KEY_REDACTION);
  return redacted.length > DETAIL_MAX_LENGTH ? redacted.slice(0, DETAIL_MAX_LENGTH) : redacted;
}
