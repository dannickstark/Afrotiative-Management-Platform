import type { RegenerateFieldsInput } from "@/lib/validation";

// PUR — décide, AVANT tout appel LLM, ce qu'une régénération doit réellement faire une fois les
// sources extraites et les images candidates connues. Vit dans son propre module sans DB ni réseau
// pour être testable en table de fixtures (voie test:pure), comme lib/queries/queue-sort.ts et
// lib/pipeline/live.ts. C'est le seul endroit où se décide « faut-il générer », « que fait-on de
// l'image » et « faut-il abandonner » — regenerateArticle ne fait qu'exécuter le plan.
export type ImageAction = "from-draft" | "skip" | "park";

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
  imageMode: "auto" | "manual";
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

  // Des candidats existent. Le mode décide QUI tranche.
  //
  // En mode AUTO on laisse generateArticle choisir : depuis la génération partielle de main
  // (lib/ai/generate-article.ts), la sélection pilote la forme du schéma demandé, donc une
  // régénération « image seule » n'envoie même pas le corps et ne coûte qu'une fraction d'un
  // article complet. Un appel dédié au choix d'image ferait doublon.
  if (input.imageMode === "auto") return { ...base, imageAction: "from-draft" };

  // En mode MANUEL, l'éditeur tranchera depuis le bac du /queue : aucun appel LLM pour l'image, et
  // on retire `image` des champs appliqués (les colonnes ne bougeront qu'au moment du choix). On ne
  // génère alors que s'il reste d'AUTRES champs cochés — une régénération « image seule » en manuel
  // se réduit à l'extraction.
  return {
    ...base,
    runGeneration: hasOtherFields(fields),
    imageAction: "park",
    effectiveFields: { ...fields, image: false },
  };
}
