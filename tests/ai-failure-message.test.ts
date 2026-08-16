// tests/ai-failure-message.test.ts — Task 2 (pur, sans DB/réseau). Une assertion par raison
// (chaîne exacte, à la lettre du brief), plus le cas "error" avec et sans `detail`.
import { describe, it, expect } from "bun:test";
import { aiFailureMessage } from "@/lib/ai/failure-message";

describe("aiFailureMessage", () => {
  it("unconfigured", () => {
    expect(aiFailureMessage("unconfigured", "régénération")).toBe("Aucun fournisseur IA configuré — régénération impossible.");
  });

  it("empty_pool", () => {
    expect(aiFailureMessage("empty_pool", "régénération")).toBe(
      "Tous les jetons OpenRouter sont inactifs ou en période de récupération — régénération impossible pour le moment.",
    );
  });

  it("rate_limited", () => {
    expect(aiFailureMessage("rate_limited", "régénération")).toBe(
      "Quota ou limite de débit atteint sur tous les jetons OpenRouter — réessayez plus tard.",
    );
  });

  it("auth_failed", () => {
    expect(aiFailureMessage("auth_failed", "régénération")).toBe(
      "Jetons OpenRouter refusés par le fournisseur (clé invalide ou révoquée) — vérifiez les jetons dans Réglages.",
    );
  });

  it("flaky", () => {
    expect(aiFailureMessage("flaky", "régénération")).toBe("L'IA a renvoyé un contenu inexploitable sur tous les fournisseurs essayés — réessayez.");
  });

  // Message DISTINCT de "error" : ici les jetons ne sont pas en cause (le fournisseur a répondu),
  // c'est le modèle qui n'a pas rendu de structure exploitable — l'utilisateur ne doit surtout pas
  // partir vérifier ses clés dans Réglages.
  it("no_object sans detail", () => {
    expect(aiFailureMessage("no_object", "régénération")).toBe(
      "Le modèle IA n'a pas renvoyé de réponse structurée exploitable — réessayez, ou changez de modèle si cela persiste.",
    );
  });

  it("no_object avec detail", () => {
    expect(aiFailureMessage("no_object", "amélioration", "response did not match schema")).toBe(
      "Le modèle IA n'a pas renvoyé de réponse structurée exploitable — réessayez, ou changez de modèle si cela persiste. Détail : response did not match schema",
    );
  });

  it("error sans detail", () => {
    expect(aiFailureMessage("error", "régénération")).toBe("Appel à l'IA en échec sur tous les fournisseurs essayés.");
  });

  it("error avec detail (interpolé tel quel, non re-tronqué)", () => {
    expect(aiFailureMessage("error", "régénération", "429 Too Many Requests")).toBe(
      "Appel à l'IA en échec sur tous les fournisseurs essayés. Dernière erreur : 429 Too Many Requests",
    );
  });

  it("action = 'amélioration'", () => {
    expect(aiFailureMessage("unconfigured", "amélioration")).toBe("Aucun fournisseur IA configuré — amélioration impossible.");
    expect(aiFailureMessage("error", "amélioration", "boom")).toBe("Appel à l'IA en échec sur tous les fournisseurs essayés. Dernière erreur : boom");
  });
});
