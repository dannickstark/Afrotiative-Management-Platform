import type { RegenerateFieldsInput } from "@/lib/validation";

// PUR — décide, AVANT tout appel LLM, ce qu'une régénération doit réellement faire une fois les
// sources extraites et les images candidates connues. Vit dans son propre module sans DB ni réseau
// pour être testable en table de fixtures (voie test:pure), comme lib/queries/queue-sort.ts et
// lib/pipeline/live.ts. C'est le seul endroit où se décide « faut-il générer », « que fait-on de
// l'image » et « faut-il abandonner » — regenerateArticle ne fait qu'exécuter le plan.
export type ImageAction = "from-draft" | "skip";

export type RegenPlan = {
  /** Faut-il appeler generateArticle ? */
  runGeneration: boolean;
  /** Ce qu'on fait de l'image à la une une fois la génération faite (ou non). */
  imageAction: ImageAction;
  /** Champs réellement appliqués — peut retirer `image` que l'appelant avait coché. */
  effectiveFields: RegenerateFieldsInput;
  /** Non-null = on n'écrit RIEN et on renvoie ce message en échec. */
  abort: string | null;
  /** Non-null = on écrit, mais le message de succès porte cet avertissement. */
  warning: string | null;
};

export const NO_CANDIDATE_MESSAGE = "Aucune image candidate trouvée — image inchangée.";

function hasOtherFields(fields: RegenerateFieldsInput): boolean {
  return fields.title || fields.body || fields.excerpt || fields.category || fields.tags;
}

export function planRegeneration(input: {
  fields: RegenerateFieldsInput;
  candidateCount: number;
}): RegenPlan {
  const { fields, candidateCount } = input;
  const base: RegenPlan = {
    runGeneration: true, imageAction: "skip", effectiveFields: fields, abort: null, warning: null,
  };

  if (!fields.image) return base;

  if (candidateCount === 0) {
    // Zéro candidat n'autorise JAMAIS à effacer l'image en place (voir l'invariant dans
    // lib/pipeline/regenerate.ts). Image seule → l'opération n'a plus d'objet, on échoue
    // explicitement plutôt que de facturer une génération complète pour un no-op.
    if (!hasOtherFields(fields)) return { ...base, runGeneration: false, abort: NO_CANDIDATE_MESSAGE };
    return { ...base, effectiveFields: { ...fields, image: false }, warning: NO_CANDIDATE_MESSAGE };
  }

  return { ...base, imageAction: "from-draft" };
}
