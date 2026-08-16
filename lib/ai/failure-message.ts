// lib/ai/failure-message.ts — Task 2a : module pur qui traduit une raison d'échec IA (mémorisée
// par generateArticle / improveArticleBody, elles-mêmes alimentées par le classement de
// lib/ai/with-token-pool.ts) en message français prêt à afficher à l'utilisateur. Aucune
// dépendance DB/réseau/`"use server"` : testable unitairement sans aucune configuration
// (voir tests/ai-failure-message.test.ts).
//
// "unconfigured" s'ajoute à PoolFailureReason (with-token-pool.ts) : ce cas ne vient jamais du
// pool lui-même (qui suppose toujours qu'on a essayé au moins un jeton) mais du niveau au-dessus
// — generateArticle/improveArticleBody — quand AUCUN fournisseur configuré n'a même été tenté.
export type AiFailureReason = "unconfigured" | "empty_pool" | "rate_limited" | "auth_failed" | "flaky" | "error";

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
    case "flaky":
      return `L'IA a renvoyé un contenu inexploitable sur tous les jetons — réessayez.`;
    case "error": {
      const base = `Appel à l'IA en échec sur tous les jetons.`;
      return detail ? `${base} Dernière erreur : ${detail}` : base;
    }
  }
}
