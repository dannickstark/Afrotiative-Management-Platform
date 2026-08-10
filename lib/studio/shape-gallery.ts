// lib/studio/shape-gallery.ts — Tâche 4 (U1, spec §3) : la galerie de formes du panneau Éléments,
// PURE. Même discipline que lib/studio/dynamic-text.ts (Tâche 3) : ce module ne fait que DÉCRIRE les
// tuiles offertes et CONSTRUIRE le calque qu'un clic insère ; le rendu et le dispatch restent dans
// components/studio/panels/elements-panel.tsx.
//
// La contrainte centrale de cette tâche (spec §3) : « Only what exists ». lib/studio/scene.ts
// (shapeLayer.shape) n'accepte AUJOURD'HUI que "rect" — plus le calque QR séparé. SHAPE_TILES ne
// doit donc lister que ces deux entrées, JAMAIS de tuile désactivée pour ellipse/ligne/polygone
// (spec §3 : « No disabled buttons for unbuilt shapes »). U3 étendra ce tableau — et UNIQUEMENT ce
// tableau — le jour où scene.ts acceptera d'autres formes ; tests/studio-shape-gallery.test.ts porte
// le garde-fou qui rend cet ajout impossible à demi-livrer (voir son premier test).
import type { Layer } from "./scene";

export type ShapeTile = {
  id: string;
  label: string; // French
  kind: "shape" | "qr";
  shape?: "rect"; // present iff kind === "shape" — le seul membre de shapeLayer.shape aujourd'hui
};

// U3 ajoute ellipse/ligne/polygones EN AJOUTANT DES ENTRÉES ICI, une fois — et seulement une fois —
// que scene.ts les accepte. Rien d'autre dans ce fichier ni dans elements-panel.tsx n'a besoin de
// changer : la section « Formes » énumère ce tableau, le test de complétude le compare au schéma.
export const SHAPE_TILES: readonly ShapeTile[] = [
  { id: "rect", label: "Rectangle", kind: "shape", shape: "rect" },
  { id: "qr", label: "QR code", kind: "qr" },
];

// Nombre de tuiles gardées sous « Utilisés récemment » (spec §3 : « capped at six ») — à la fois à
// l'affichage (recentTilesFor) et dans la liste PERSISTÉE elle-même (withRecentShape), pour que le
// stockage ne croisse jamais sans borne même si le catalogue de tuiles grandit un jour bien au-delà
// de six avec U3.
const MAX_RECENT = 6;

// PURE — la taille/position du calque inséré, relative au CANEVAS plutôt que fixe (même principe que
// dynamic-text.ts:frameFor) : un carré aux ~35 % de la plus petite dimension du canevas atterrit
// toujours À L'INTÉRIEUR, qu'il s'agisse d'un format large (lien, 1200×630) ou étroit (story,
// 1080×1920) — une taille pensée pour l'un déborderait de l'autre sans cette relativisation.
const SIZE_RATIO = 0.35;

function frameFor(canvas: { width: number; height: number }): Layer["frame"] {
  const desired = Math.min(canvas.width, canvas.height) * SIZE_RATIO;
  // Bornée aux dimensions du canevas d'abord, puis centrée et reclampée — garantit x/y >= 0 et
  // x+w/y+h <= canevas quel que soit le format (même clamp final que dynamic-text.ts:frameFor).
  const w = Math.min(Math.max(desired, 1), canvas.width);
  const h = Math.min(Math.max(desired, 1), canvas.height);
  const x = Math.min(Math.max(Math.round((canvas.width - w) / 2), 0), canvas.width - w);
  const y = Math.min(Math.max(Math.round((canvas.height - h) / 2), 0), canvas.height - h);
  return { x, y, w, h };
}

// PURE — le calque qu'un clic sur une tuile insère. Un calque NORMAL, sans statut spécial : un
// designer peut ensuite modifier sa forme, sa couleur ou (pour le QR) son jeton d'emplacement depuis
// le panneau de propriétés exactement comme n'importe quel calque créé autrement — même garantie que
// buildDynamicTextLayer (dynamic-text.ts). Les valeurs par défaut (fill, fg/bg/margin) reprennent
// EXACTEMENT celles du calque générique (editor-state.ts:createLayer) : seule la taille change ici,
// pas les couleurs par défaut — pas de raison de diverger de ce que « Ajouter un calque » produit déjà.
export function buildShapeLayer(tile: ShapeTile, canvas: { width: number; height: number }): Layer {
  const frame = frameFor(canvas);
  const base = { id: crypto.randomUUID(), name: tile.label, visible: true, locked: false, frame };

  switch (tile.kind) {
    case "shape": {
      if (!tile.shape) {
        throw new Error(`shape-gallery.ts : la tuile « ${tile.id} » est de type "shape" mais ne porte pas de champ shape.`);
      }
      return { ...base, type: "shape", shape: tile.shape, fill: "#CCCCCC" };
    }
    case "qr":
      return { ...base, type: "qr", slot: "qr", fg: "#000000", bg: "#FFFFFF", margin: 4 };
  }
}

// PURE — résout la liste PERSISTÉE d'ids de tuile (EditorPrefs.recentShapes, Tâche 4 : la plus
// récente en tête) en tuiles réelles pour la section « Utilisés récemment » (spec §3). Un id qui ne
// correspond plus à aucune tuile (catalogue réduit depuis, corruption de préférences) est ignoré en
// silence plutôt que de planter — même discipline défensive que editor-prefs.ts.
export function recentTilesFor(recentShapes: readonly string[]): ShapeTile[] {
  const tiles: ShapeTile[] = [];
  for (const id of recentShapes) {
    const tile = SHAPE_TILES.find((t) => t.id === id);
    if (tile && !tiles.includes(tile)) tiles.push(tile);
    if (tiles.length === MAX_RECENT) break;
  }
  return tiles;
}

// PURE — la nouvelle valeur de EditorPrefs.recentShapes après un clic sur la tuile `id` : elle passe
// en tête, sans doublon, et la liste stockée elle-même reste bornée à MAX_RECENT.
export function withRecentShape(recentShapes: readonly string[], id: string): string[] {
  return [id, ...recentShapes.filter((existing) => existing !== id)].slice(0, MAX_RECENT);
}
