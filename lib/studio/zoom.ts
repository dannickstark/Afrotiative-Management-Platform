// lib/studio/zoom.ts — Chantier B, Tâche 3 : le VRAI zoom, en PUR (aucun import React/DOM/base de
// données — même discipline que lib/studio/keymap.ts, lib/studio/editor-prefs.ts). Ce module ne
// connaît ni `EditorPrefs` ni le DOM : il ne fait que transformer des nombres.
//
// ── LE MODÈLE : `scale = fitScale × factor` ──────────────────────────────────────────────────────
// `fitScale` (components/studio/editor-shell.tsx#computeCanvasScale) reste EXACTEMENT ce qu'il est
// aujourd'hui : la mesure du conteneur, recalculée par le ResizeObserver, jamais touchée ici. Le
// `factor` produit par ce module est TOUJOURS relatif à `fitScale` — « 1 » signifie « exactement
// l'ajustement courant », jamais « 100 % de la taille native » (c'est `zoomPresetScale("100", …)`
// qui fait cette conversion explicitement, voir plus bas). C'est ce qui rend `factor: "fit"`
// (EditorPrefs.zoom déjà existant, lib/studio/editor-prefs.ts) NEUTRE par construction : un gabarit
// ouvert avec la préférence `"fit"` applique `factor = 1`, donc `scale = fitScale × 1 = fitScale` —
// BIT À BIT le comportement d'avant cette tâche (§0 non-régression du brief).
//
// ── BORNES : POURQUOI 0,1–8 ────────────────────────────────────────────────────────────────────
// Reprises TELLES QUELLES de l'exemple du brief (« clampZoom(factor: number): number (e.g. 0.1–8) »)
// — pas un choix arbitraire de ce module : `ZOOM_STEPS` ci-dessous DÉFINIT ces bornes (son premier et
// son dernier élément), pour qu'un seul et même tableau serve à la fois de pas pour +/- et de source
// de vérité pour le clamp — jamais deux constantes qui pourraient diverger.

/** Pas de zoom, en FACTEUR relatif à `fitScale` (PAS un pourcentage absolu) — voir l'en-tête de
 * module. Croissant, sans doublon : `nextZoom` ci-dessous suppose les deux. `1` y figure toujours
 * (« exactement l'ajustement »), au même titre que n'importe quel autre pas. */
export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Ramène un facteur dans les bornes de `ZOOM_STEPS` (0,1–8) — INCLUSIVES des deux côtés, même
 * discipline que `clampPanelWidth` (lib/studio/editor-prefs.ts). Une valeur non finie (NaN, +/-
 * Infinity — jamais produite par ce module lui-même, mais une préférence corrompue chargée depuis
 * localStorage pourrait un jour en porter une malgré `parseZoom`) retombe sur `1` (« l'ajustement »,
 * le seul point du domaine qui ne dépend d'aucune mesure de conteneur) plutôt que de laisser NaN se
 * propager dans `scale = fitScale × factor`. */
export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.min(Math.max(factor, ZOOM_MIN), ZOOM_MAX);
}

const STEP_EPSILON = 1e-9;

/** Le pas suivant de `ZOOM_STEPS` dans la direction `dir` — `1` pour zoomer AVANT (agrandir), `-1`
 * pour zoomer ARRIÈRE (réduire) — à partir d'un facteur COURANT qui n'est pas nécessairement lui-même
 * un pas exact de `ZOOM_STEPS` (ex. après un zoom sur sélection, qui produit un facteur continu).
 *
 * Règle : le premier pas STRICTEMENT au-delà du facteur courant, dans la direction demandée — jamais
 * le pas le plus proche, qui resterait immobile pour un facteur déjà très proche d'un pas sans lui
 * être IDENTIQUE. Aux deux bords, reste sur le pas extrême (`ZOOM_STEPS[0]`/dernier) plutôt que de
 * sortir du tableau — le même comportement de saturation que `clampZoom`. */
export function nextZoom(factor: number, dir: 1 | -1): number {
  const current = clampZoom(factor);
  if (dir > 0) {
    for (const step of ZOOM_STEPS) {
      if (step > current + STEP_EPSILON) return step;
    }
    return ZOOM_MAX;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = ZOOM_STEPS[i];
    if (step < current - STEP_EPSILON) return step;
  }
  return ZOOM_MIN;
}

/** Une boîte englobante en pixels NATIFS du gabarit — même forme que `Frame` (lib/studio/scene.ts),
 * dupliquée ICI plutôt qu'importée pour que ce module reste une FEUILLE (voir keymap.ts#NUDGE_STEP
 * pour le même motif et la même justification : lib/studio/scene.ts n'entraîne aucune dépendance
 * lourde, mais ce module documente délibérément qu'il ne connaît AUCUN autre type métier). */
export interface ZoomBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** La zone disponible à l'écran (px CSS) dans laquelle cadrer une sélection — le conteneur du
 * canevas (editor-shell.tsx#canvasWrapRef), mesuré au moment du clic/raccourci, PAS mémorisé dans un
 * état React (une mesure obsolète après un redimensionnement de fenêtre serait pire qu'aucune). */
export interface ZoomViewport {
  width: number;
  height: number;
}

/** L'union de plusieurs boîtes (une sélection multiple) — `null` pour un tableau vide (rien à
 * cadrer), jamais une boîte factice à {0,0,0,0} qui produirait un facteur infini plus bas. Ignore
 * délibérément la rotation (`Layer.rotation`, lib/studio/scene.ts) : une boîte AXE-ALIGNÉE sur les
 * `frame` bruts est une approximation raisonnable et déterministe pour « cadrer la sélection », la
 * même simplification que align.ts fait déjà pour ses propres calculs de boîte englobante. */
export function unionBounds(boxes: readonly ZoomBounds[]): ZoomBounds | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Marge laissée AUTOUR d'une sélection cadrée (spec produit implicite : cadrer pile au pixel près
 * collerait la sélection contre les bords du canevas visible) — 90 % de la zone disponible, un
 * FACTEUR pur plutôt qu'un pad en pixels (contrairement à `computeCanvasScale`, editor-shell.tsx, qui
 * retranche `RULER_SIZE` en pixels ÉCRAN) : ce module ignore délibérément les règles/la grille (des
 * détails d'écran, pas de géométrie de zoom) pour rester indépendant de canvas-chrome.tsx. */
const SELECTION_FILL_RATIO = 0.9;

/**
 * Le facteur (relatif à `fitScale`, JAMAIS une échelle absolue — voir l'en-tête de module) pour l'un
 * des trois préréglages du slot de zoom (editor-shell.tsx) :
 *   - `"fit"` : `1` — `scale = fitScale × 1 = fitScale`, l'ajustement courant, EXACTEMENT le
 *     comportement d'avant cette tâche.
 *   - `"100"` : `1 / fitScale` — `scale = fitScale × (1 / fitScale) = 1`, l'artboard au pixel natif
 *     près, quelle que soit la valeur de `fitScale` pour CE gabarit/CETTE fenêtre.
 *   - `"selection"` : la boîte englobante `selectionBounds` cadrée dans `viewport`, à
 *     `SELECTION_FILL_RATIO` de la zone disponible — `absoluteTarget / fitScale` pour rester dans le
 *     même espace « relatif à fitScale » que les deux autres branches. Retombe sur `1` (« fit »,
 *     jamais un `NaN`/une échelle folle) si `selectionBounds`/`viewport` sont absents ou dégénérés
 *     (boîte ou zone de taille nulle) — l'appelant (hooks/use-editor-keymap.ts,
 *     components/studio/editor-shell.tsx) n'a alors rien de valide à cadrer.
 *
 * Le résultat passe TOUJOURS par `clampZoom` : un préréglage reste un facteur comme un autre, jamais
 * une échappatoire aux bornes 0,1–8.
 */
export function zoomPresetScale(
  kind: "fit" | "100" | "selection",
  fitScale: number,
  selectionBounds?: ZoomBounds | null,
  viewport?: ZoomViewport | null,
): number {
  if (kind === "fit") return 1;
  if (kind === "100") return clampZoom(1 / fitScale);

  // "selection"
  if (
    !selectionBounds || !viewport ||
    selectionBounds.w <= 0 || selectionBounds.h <= 0 ||
    viewport.width <= 0 || viewport.height <= 0
  ) {
    return 1;
  }
  const absoluteTarget =
    Math.min(viewport.width / selectionBounds.w, viewport.height / selectionBounds.h) * SELECTION_FILL_RATIO;
  return clampZoom(absoluteTarget / fitScale);
}
