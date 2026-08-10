// lib/studio/shape-gallery.ts — Tâche 4 (U1, spec §3) : la galerie de formes du panneau Éléments,
// PURE. Même discipline que lib/studio/dynamic-text.ts (Tâche 3) : ce module ne fait que DÉCRIRE les
// tuiles offertes et CONSTRUIRE le calque qu'un clic insère ; le rendu et le dispatch restent dans
// components/studio/panels/elements-panel.tsx.
//
// La contrainte centrale de cette tâche (spec §3) : « Only what exists ». lib/studio/scene.ts
// (SHAPE_KINDS, shapeLayer.shape) n'accepte AUJOURD'HUI que "rect" — plus le calque QR séparé.
// SHAPE_TILES ne doit donc lister que ces deux entrées, JAMAIS de tuile désactivée pour
// ellipse/ligne/polygone (spec §3 : « No disabled buttons for unbuilt shapes »). U3 étendra
// SHAPE_KINDS (scene.ts) ET ce tableau le jour où le schéma acceptera d'autres formes ;
// tests/studio-shape-gallery.test.ts porte le garde-fou qui rend cet ajout impossible à demi-livrer.
//
// Revue Tâche 4, Important 1 — corrigé : le garde-fou d'origine comparait SHAPE_TILES à une copie
// manuscrite de la liste de formes DANS LE TEST, pas au schéma réel (scene.ts). Les deux copies
// pouvaient dériver ENSEMBLE sans qu'aucun test ne le remarque — le scénario dangereux (quelqu'un
// étend scene.ts sans toucher ce fichier ni le test) restait invisible. `ShapeTile.shape` est
// maintenant TYPÉ depuis `SHAPE_KINDS` (scene.ts, la même liste que consomme z.enum côté schéma) et
// le test de complétude itère `SHAPE_KINDS` directement plutôt qu'une copie — même construction que
// lib/diffusion/channels.ts (itère CHANNELS) et lib/studio/dynamic-text.ts (itère TOKEN_IDS).
import { SHAPE_KINDS, type Layer } from "./scene";
import { CONTEXT_TOKENS, type TemplateContext, type TokenId } from "./tokens";

export type ShapeTile = {
  id: string;
  label: string; // French
  kind: "shape" | "qr";
  shape?: (typeof SHAPE_KINDS)[number]; // present iff kind === "shape"
};

// U3 ajoute ellipse/ligne/polygones EN AJOUTANT DES ENTRÉES ICI, une fois — et seulement une fois —
// que SHAPE_KINDS (scene.ts) les accepte. La section « Formes » énumère ce tableau ; le garde-fou de
// complétude le compare au SCHÉMA, pas à une copie de ce tableau.
export const SHAPE_TILES: readonly ShapeTile[] = [
  { id: "rect", label: "Rectangle", kind: "shape", shape: "rect" },
  { id: "qr", label: "QR code", kind: "qr" },
];

// Le jeton que le calque QR encode réellement (spec §4, dernière phrase : « article.url is offered
// under Éléments as a QR tile rather than as text »). LÉGAL UNIQUEMENT dans social_post
// (lib/studio/tokens.ts, CONTEXT_TOKENS — article.url n'existe qu'après publication WordPress).
const QR_URL_TOKEN: TokenId = "article.url";

// Libellé français du contexte, pour la phrase de raison d'une tuile indisponible — MÊME
// vocabulaire et MÊME duplication déjà documentés par lib/studio/dynamic-text.ts (CONTEXT_LABEL) :
// dupliqué plutôt qu'importé pour rester un module PUR sans traîner de dépendance côté client.
const CONTEXT_LABEL: Record<TemplateContext, string> = {
  article_image: "Image à la une",
  social_post: "Publication sociale",
  quote_card: "Carte citation",
  newsletter_header: "Bandeau newsletter",
  recap_card: "Carte récap",
};

// Nombre de tuiles gardées sous « Utilisés récemment » (spec §3 : « capped at six ») — à la fois à
// l'affichage (recentTilesFor) et dans la liste PERSISTÉE elle-même (withRecentShape), pour que le
// stockage ne croisse jamais sans borne même si le catalogue de tuiles grandit un jour bien au-delà
// de six avec U3.
const MAX_RECENT = 6;

export type ShapeTileRow = ShapeTile & {
  available: boolean; // false when the tile's binding target is illegal in this context (QR only)
  reason?: string; // French, present iff !available
};

// PURE — la règle testée par tests/studio-shape-gallery.test.ts (revue Tâche 4, Important 2). Une
// ligne par tuile de l'univers COMPLET, jamais seulement les disponibles — même discipline que
// dynamic-text.ts:dynamicTextRowsFor : une tuile indisponible reste VISIBLE, gréée avec sa raison,
// plutôt que simplement absente. Seule la tuile QR dépend du contexte (son jeton d'emplacement,
// article.url, n'existe que dans social_post) ; la tuile rectangle est toujours disponible.
export function shapeTilesFor(context: TemplateContext): ShapeTileRow[] {
  return SHAPE_TILES.map((tile) => {
    if (tile.kind !== "qr") return { ...tile, available: true };
    const available = CONTEXT_TOKENS[context].includes(QR_URL_TOKEN);
    return {
      ...tile,
      available,
      reason: available
        ? undefined
        : `Indisponible pour ce type de gabarit (« ${CONTEXT_LABEL[context]} »).`,
    };
  });
}

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

// PURE — le calque qu'un clic sur une tuile DISPONIBLE insère. Un calque NORMAL, sans statut
// spécial : un designer peut ensuite modifier sa forme, sa couleur ou (pour le QR) son jeton
// d'emplacement depuis le panneau de propriétés exactement comme n'importe quel calque créé
// autrement — même garantie que buildDynamicTextLayer (dynamic-text.ts).
//
// Revue Tâche 4, Important 2 — corrigé : la version d'origine posait `slot: "qr"`, un placeholder
// qui ne correspond à AUCUN jeton réel (identique au calque générique pré-existant,
// editor-state.ts:createLayer) — validateScene le refuse aussitôt comme « jeton inconnu ». `context`
// permet de poser le VRAI jeton (article.url) quand il est légal ici, conformément à la dernière
// phrase de la spec §4. Le composant appelant (elements-panel.tsx) ne construit ce calque que pour
// une tuile `available` (shapeTilesFor) ; le repli sur le placeholder ne sert qu'à garder cette
// fonction totale si elle est appelée hors de ce chemin (ex. directement depuis un test).
export function buildShapeLayer(
  tile: ShapeTile,
  canvas: { width: number; height: number },
  context: TemplateContext,
): Layer {
  const frame = frameFor(canvas);
  const base = { id: crypto.randomUUID(), name: tile.label, visible: true, locked: false, frame };

  switch (tile.kind) {
    case "shape": {
      if (!tile.shape) {
        throw new Error(`shape-gallery.ts : la tuile « ${tile.id} » est de type "shape" mais ne porte pas de champ shape.`);
      }
      return { ...base, type: "shape", shape: tile.shape, fill: "#CCCCCC" };
    }
    case "qr": {
      const slot = CONTEXT_TOKENS[context].includes(QR_URL_TOKEN) ? QR_URL_TOKEN : "qr";
      return { ...base, type: "qr", slot, fg: "#000000", bg: "#FFFFFF", margin: 4 };
    }
  }
}

// PURE — résout la liste PERSISTÉE d'ids de tuile (EditorPrefs.recentShapes, Tâche 4 : la plus
// récente en tête) en LIGNES réelles (avec leur disponibilité DANS CE CONTEXTE) pour la section
// « Utilisés récemment » (spec §3). `rows` vient de shapeTilesFor(context) — jamais de SHAPE_TILES
// brut — pour qu'une tuile récemment utilisée mais devenue indisponible ici (ex. QR utilisé dans un
// gabarit social_post, rouvert depuis un gabarit quote_card) apparaisse gréée plutôt que comme si de
// rien n'était. Un id qui ne correspond plus à aucune tuile (catalogue réduit depuis, corruption de
// préférences) est ignoré en silence plutôt que de planter — même discipline défensive que
// editor-prefs.ts.
export function recentTilesFor(rows: readonly ShapeTileRow[], recentShapes: readonly string[]): ShapeTileRow[] {
  const tiles: ShapeTileRow[] = [];
  for (const id of recentShapes) {
    const tile = rows.find((t) => t.id === id);
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
