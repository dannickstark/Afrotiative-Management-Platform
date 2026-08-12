// lib/studio/groups.ts — Chantier B, Tâche 5 : le modèle FLAT `groupId`, en PURE.
//
// Un module FEUILLE au même sens qu'align.ts (voir son en-tête) : aucun DOM, aucun React, aucun
// réducteur — seulement des fonctions d'une scène/liste de calques vers une valeur, testables avec
// des littéraux. `boundingBox` (align.ts) est réutilisée telle quelle pour `groupBounds` plutôt que
// recopiée : c'est LA géométrie déjà éprouvée par aligner/répartir (U2, Tâche 4), et une seconde
// définition pourrait dériver de la première sans qu'aucun test ne le remarque — exactement le motif
// que colorFieldPaths (scene.ts) et boundingBox lui-même documentent déjà pour leurs propres voisins.
//
// ── LE MODÈLE, DÉLIBÉRÉMENT PLAT (spec chantier B §6) ─────────────────────────────────────────────
// Grouper N calques sélectionnés = leur assigner un `groupId` neuf PARTAGÉ (une chaîne, voir
// `nextGroupId`). Il n'existe AUCUN calque « groupe » séparé dans `scene.layers`, et AUCUNE
// imbrication : un calque a au plus UN `groupId`, jamais une liste, jamais un groupe DANS un groupe.
// « Le groupe » n'est donc jamais une donnée stockée à part — c'est toujours un ENSEMBLE DÉRIVÉ,
// recalculé à la volée par `expandSelectionToGroups` à partir de `scene.layers`. Dégrouper efface ce
// `groupId` (voir editor-state.ts#setGroup, `groupId: null`) ; rien d'autre à nettoyer.
import type { Frame, Layer, Scene } from "./scene";
import { boundingBox } from "./align";

/**
 * La sélection à DISPATCHER pour un clic sur `ids` (typiquement UN id, le calque cliqué) — chaque id
 * dont le calque appartient à un groupe est étendu à TOUS les membres de CE groupe ; un calque SANS
 * `groupId` (ou dont l'id ne désigne aucun calque de `scene` — la sélection n'est de toute façon
 * jamais validée contre la scène, voir editor-state.ts en-tête point 2) se renvoie lui-même, seul.
 *
 * DÉDOUBLONNÉE, dans un ORDRE DÉTERMINISTE : les membres d'un même groupe sortent dans l'ordre de
 * `scene.layers` (l'ordre de peinture), jamais dans l'ordre — non significatif ici — de `ids` en
 * entrée. C'est ce qui rend le résultat STABLE : appliquer `expandSelectionToGroups` à son propre
 * résultat renvoie exactement le même ensemble, dans le même ordre (idempotence, sweepée par
 * tests/studio-groups.test.ts).
 */
export function expandSelectionToGroups(ids: readonly string[], scene: Scene): string[] {
  const byId = new Map(scene.layers.map((l) => [l.id, l] as const));
  const out: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    const groupId = byId.get(id)?.groupId;
    if (!groupId) {
      seen.add(id);
      out.push(id);
      continue;
    }
    // Groupé : TOUS les calques qui partagent CE groupId, dans l'ordre de `scene.layers` — pas
    // seulement celui qu'on vient de croiser dans `ids`.
    for (const layer of scene.layers) {
      if (layer.groupId === groupId && !seen.has(layer.id)) {
        seen.add(layer.id);
        out.push(layer.id);
      }
    }
  }
  return out;
}

/**
 * La boîte englobante des cadres NON PIVOTÉS des calques donnés — DÉLÈGUE à `boundingBox` (align.ts,
 * U2 Tâche 4) plutôt que de recalculer min/max une seconde fois, avec la MÊME réserve qu'elle
 * documente déjà (décision 1 de son en-tête) : la rotation n'est pas prise en compte, par cohérence
 * avec aligner/répartir/accrocher, qui font tous le même choix pour la même raison (prévisibilité).
 * `Frame`, jamais `Frame | null` (contrairement à `boundingBox`) : un groupe existe toujours avec AU
 * MOINS un membre (grouper zéro/un calque n'a pas de sens, voir hooks/use-editor-keymap.ts) — le repli
 * `{x:0,y:0,w:0,h:0}` ne couvre donc que l'appel dégénéré à zéro calque, jamais un cas réel du
 * réducteur.
 */
export function groupBounds(layers: readonly Layer[]): Frame {
  return boundingBox(layers.map((l) => l.frame)) ?? { x: 0, y: 0, w: 0, h: 0 };
}

/** Un identifiant de groupe neuf — LA MÊME source que le réducteur utilise pour tout id de calque
 *  (`crypto.randomUUID()`, voir editor-state.ts#createLayer) : jamais un second schéma d'id. */
export function nextGroupId(): string {
  return crypto.randomUUID();
}
