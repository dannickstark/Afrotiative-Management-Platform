// lib/ai/failure-message.ts — Task 2a : module pur qui traduit une raison d'échec IA (mémorisée
// par generateArticle / improveArticleBody, elles-mêmes alimentées par le classement de
// lib/ai/with-token-pool.ts) en message français prêt à afficher à l'utilisateur. Aucune
// dépendance DB/réseau/`"use server"` : testable unitairement sans aucune configuration
// (voir tests/ai-failure-message.test.ts).
//
// Ce type est exactement PoolFailureReason (with-token-pool.ts). "unconfigured" a deux origines
// désormais : le pool, quand il constate qu'aucun jeton n'existe (aucune ligne openrouter_tokens
// ET aucune clé d'environnement — voir lib/ai/token-pool.ts), et le niveau au-dessus —
// generateArticle/improveArticleBody — quand AUCUN fournisseur configuré n'a même été tenté. Les
// deux disent la même chose à l'utilisateur, d'où un seul message.
export type AiFailureReason =
  | "unconfigured"
  | "empty_pool"
  | "rate_limited"
  | "auth_failed"
  | "flaky"
  | "no_object"
  | "error";

// `detail` provient de PoolResult.detail (with-token-pool.ts), DÉJÀ tronqué à 200 caractères par
// Task 1 — on ne le re-tronque ni ne le réinterprète ici, on l'interpole tel quel.
export function aiFailureMessage(reason: AiFailureReason, action: "régénération" | "amélioration", detail?: string): string {
  switch (reason) {
    case "unconfigured":
      return `Aucun fournisseur IA configuré — ${action} impossible.`;
    case "empty_pool":
      return `Tous les jetons OpenRouter sont inactifs ou en période de récupération — ${action} impossible pour le moment.`;
    case "rate_limited":
      return `Quota ou limite de débit atteint sur tous les jetons OpenRouter — réessayez plus tard.`;
    case "auth_failed":
      return `Jetons OpenRouter refusés par le fournisseur (clé invalide ou révoquée) — vérifiez les jetons dans Réglages.`;
    // "flaky" et "error" sont les DEUX seules raisons qu'un fournisseur non-OpenRouter peut produire
    // (generate-article.ts / improve-article.ts les mémorisent quand un modèle construit directement
    // par buildModel échoue) : dans ce cas aucun pool de jetons n'entre en jeu, d'où une formulation
    // qui parle de fournisseurs et non de jetons. Les autres raisons viennent exclusivement du pool
    // OpenRouter et gardent donc leur vocabulaire « jetons ».
    case "flaky":
      return `L'IA a renvoyé un contenu inexploitable sur tous les fournisseurs essayés — réessayez.`;
    // Volontairement SANS vocabulaire « jeton » ni renvoi vers Réglages : le fournisseur a répondu
    // et la clé a fonctionné — c'est le modèle qui n'a pas rendu de structure conforme. Envoyer
    // l'utilisateur vérifier ses clés le mettrait sur une fausse piste ; le levier utile est le
    // modèle (OPENROUTER_MODEL) ou une simple relance.
    case "no_object": {
      const base = `Le modèle IA n'a pas renvoyé de réponse structurée exploitable — réessayez, ou changez de modèle si cela persiste.`;
      return detail ? `${base} Détail : ${detail}` : base;
    }
    case "error": {
      const base = `Appel à l'IA en échec sur tous les fournisseurs essayés.`;
      return detail ? `${base} Dernière erreur : ${detail}` : base;
    }
  }
}
