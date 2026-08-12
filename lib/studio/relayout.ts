import type { Frame, HConstraint, LayerConstraints, Scene, VConstraint } from "@/lib/studio/scene";
import { constraintsOf } from "@/lib/studio/scene";
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";

// Chantier D, Tâche 2 — LE moteur pur `relayout`. Étant un même gabarit dessiné pour UN canevas
// (« base »), comment son cadre s'ajuste-t-il quand le format change (« cible ») ? La réponse est
// la grille de contraintes de Figma : chaque calque porte deux contraintes indépendantes, une par
// axe (`h` pour horizontal, `v` pour vertical), qui décrivent quel(s) bord(s) du calque restent à
// distance FIXE des bords du canevas. Ce module reste DB-free / client-safe (TEST_LANE=pure) : il
// ne fait QUE de l'arithmétique sur des nombres, jamais d'E/S.

// ─────────────────────────────────────────────────────────────────────────────
// relayoutAxis — LE cœur mathématique, un seul axe à la fois (H et V partagent la même formule,
// seuls les noms des modes diffèrent : left/right/leftRight ↔ top/bottom/topBottom).
//
//   • left / top       — le bord PROCHE (gauche/haut) reste à distance fixe : le calque garde sa
//                         position ET sa taille, quel que soit le format cible. C'est le comportement
//                         D'AUJOURD'HUI (avant Tâche 1), ce qui rend `left`/`top` le défaut qui garantit
//                         la migration no-op.
//   • right / bottom   — le bord LOIN (droit/bas) reste à distance fixe du bord du canevas ; la
//                         taille ne change pas, seule la position glisse de (cible - base).
//   • leftRight / topBottom — LES DEUX bords restent à distance fixe : le calque s'ÉTIRE. La
//                         position (bord proche) ne bouge pas ; la taille absorbe tout le delta
//                         (cible - base). Peut donner une taille négative pour une cible plus petite
//                         que l'écart des deux bords : c'est `relayoutFrame` qui clampe, PAS cette
//                         fonction — `relayoutAxis` reste la formule NUE, testable directement.
//   • center           — le DÉCALAGE entre le centre du calque et le centre du canevas reste fixe ;
//                         la taille ne change pas.
//   • scale            — position ET taille suivent le même facteur d'échelle (cible / base) : un
//                         agrandissement pur, proportionnel.
// ─────────────────────────────────────────────────────────────────────────────
export function relayoutAxis(
  pos: number,
  size: number,
  base: number,
  target: number,
  mode: HConstraint | VConstraint,
): { pos: number; size: number } {
  switch (mode) {
    case "left":
    case "top":
      return { pos, size };
    case "right":
    case "bottom":
      return { pos: pos + (target - base), size };
    case "leftRight":
    case "topBottom":
      return { pos, size: size + (target - base) };
    case "center":
      return { pos: pos + (target - base) / 2, size };
    case "scale": {
      const scale = target / base;
      return { pos: pos * scale, size: size * scale };
    }
  }
}

// La taille minimale d'un cadre — un calque ne disparaît jamais totalement, même quand
// `leftRight`/`topBottom` produit une taille négative ou nulle pour une cible bien plus petite que
// l'écart des deux bords. Même clamp que `lib/studio/layer-geometry.ts#centeredFrame` (pas de
// deuxième définition : ce module reste FEUILLE, sans dépendance vers layer-geometry.ts).
const MIN_SIZE = 1;

// relayoutFrame — LES DEUX axes + le clamp de taille minimale. La position n'est JAMAIS clampée
// (un calque peut légitimement sortir du canevas, ex. `right` sur une cible bien plus étroite) —
// seule la taille l'est, pour qu'un calque garde toujours une existence géométrique.
export function relayoutFrame(
  frame: Frame,
  c: LayerConstraints,
  base: { w: number; h: number },
  target: { w: number; h: number },
): Frame {
  const hAxis = relayoutAxis(frame.x, frame.w, base.w, target.w, c.h);
  const vAxis = relayoutAxis(frame.y, frame.h, base.h, target.h, c.v);
  return {
    x: hAxis.pos,
    y: vAxis.pos,
    w: Math.max(MIN_SIZE, hAxis.size),
    h: Math.max(MIN_SIZE, vAxis.size),
  };
}

// relayout — LE moteur au niveau de la scène entière. Nouvelle scène, jamais de mutation de
// l'entrée : `canvas.{width,height}` prend les dimensions cible, et CHAQUE calque reçoit un
// nouveau cadre — soit sa SURCHARGE pour ce format si `formatKey` en porte une (elle GAGNE et
// ignore totalement la contrainte du calque), soit `relayoutFrame` appliqué à ses contraintes
// (`constraintsOf`, Tâche 1 — retombe sur { h: "left", v: "top" } en son absence).
//
// `formatKey` est OPTIONNEL : sans lui, aucune surcharge n'est consultée (impossible de savoir
// « pour quel format » chercher dans `scene.formatOverrides`, qui est indexé par clé de format, pas
// par dimensions) — c'est le chemin que prend l'identité au format d'accueil, qui ne connaît que des
// dimensions brutes. `relayoutToFormat` ci-dessous est l'appelant qui fournit systématiquement la
// clé.
export function relayout(scene: Scene, target: { w: number; h: number }, formatKey?: string): Scene {
  const base = { w: scene.canvas.width, h: scene.canvas.height };
  const overridesForFormat = formatKey !== undefined ? scene.formatOverrides?.[formatKey] : undefined;

  return {
    ...scene,
    canvas: { ...scene.canvas, width: target.w, height: target.h },
    layers: scene.layers.map((layer) => {
      const override = overridesForFormat?.[layer.id];
      const frame = override !== undefined
        ? { ...override }
        : relayoutFrame(layer.frame, constraintsOf(layer), base, target);
      return { ...layer, frame };
    }),
  };
}

// relayoutToFormat — la façade que le reste de l'application appelle : résout les dimensions cible
// depuis `FORMAT_PRESETS` (la SEULE source de vérité des dimensions d'un format, `lib/studio/formats.ts`)
// et transmet la clé de format à `relayout` pour que ses surcharges soient bien consultées.
export function relayoutToFormat(scene: Scene, format: FormatKey): Scene {
  const preset = FORMAT_PRESETS[format];
  return relayout(scene, { w: preset.width, h: preset.height }, format);
}
