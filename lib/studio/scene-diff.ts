// lib/studio/scene-diff.ts — comparaison STRUCTURELLE de deux scènes (Tâche 9).
//
// Sert à dériver, CÔTÉ CLIENT, le badge « modifications non publiées » de l'éditeur : le brouillon
// (`state.scene`, tenu par le réducteur) est comparé à l'instantané publié chargé au montage de la
// page. Même stratégie que lib/queries/studio.ts:sortKeysDeep/canonicalJson (qui sert le MÊME calcul
// pour la liste des gabarits) — dupliquée ICI plutôt qu'importée depuis lib/queries/studio.ts, qui
// tire `@/db` (le pool `pg`) dans son graphe et casserait donc l'éditeur au premier import côté
// client (voir la note de components/studio/templates-table.tsx sur exactement ce piège).
import type { Scene } from "./scene";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function canonicalSceneJson(scene: Scene): string {
  return JSON.stringify(sortKeysDeep(scene));
}

// true si les deux scènes sont IDENTIQUES une fois l'ordre des clés neutralisé — PAS une simple
// comparaison de référence ni un JSON.stringify brut (l'ordre des clés d'un objet reconstruit par
// le réducteur — via les spreads de lib/studio/editor-state.ts — n'a aucune raison de rester
// stable face à l'ordre d'origine renvoyé par Postgres).
export function scenesEqual(a: Scene, b: Scene): boolean {
  return canonicalSceneJson(a) === canonicalSceneJson(b);
}

// « Modifications non publiées », PRÊTE À AFFICHER (Tâche 9 — revue Lot 1 : hasUnpublishedChanges
// vaut déjà `true` pour un gabarit JAMAIS publié — publishedVersion === null — ce qui est correct
// pour la LISTE (lib/queries/studio.ts) mais produirait, dans L'ÉDITEUR, un badge « modifications
// non publiées » affiché EN PLUS du badge « Brouillon » sur un gabarit tout juste créé : deux
// badges qui se contredisent pour un seul et même état. Cette fonction porte donc la condition
// SUPPLÉMENTAIRE explicitement requise par la revue : le badge n'apparaît que si le gabarit a DÉJÀ
// été publié au moins une fois ET que le brouillon courant diverge de cet instantané.
export function shouldShowUnpublishedBadge(
  publishedVersion: number | null,
  draftScene: Scene,
  publishedScene: Scene | null,
): boolean {
  if (publishedVersion === null || publishedScene === null) return false;
  return !scenesEqual(draftScene, publishedScene);
}
