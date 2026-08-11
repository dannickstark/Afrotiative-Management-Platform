"use client";

import { useRef, useState, useCallback } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent } from "react";
import type { Frame, Layer } from "@/lib/studio/scene";
import {
  moveLayer, resizeLayer, rotateLayer, setFrames, toCanvasCoords,
  type EditorAction, type Point,
} from "@/lib/studio/editor-state";
import { sameFrame } from "@/lib/studio/align";
import {
  snapCandidates, snapMove, snapResize,
  type SnapGuide, type SnapSubject,
} from "@/lib/studio/snap";

// ─────────────────────────────────────────────────────────────────────────────
// Géométrie PURE — aucune dépendance à React ni au DOM. C'est ce qui rend ce fichier testable sans
// monter de composant (voir tests/studio-drag.test.ts, et la même convention que
// hooks/use-persisted-filters.ts : « pas de DOM dans bun test »).

export type HandleId = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: HandleId[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export interface HandleAxes {
  hasN: boolean;
  hasS: boolean;
  hasE: boolean;
  hasW: boolean;
  isCorner: boolean;
}

// Table poignée -> axes portés, extraite en fonction PURE et EXPORTÉE (revue Tâche 2 : la Tâche 5,
// accroche/guides, doit savoir pour une poignée en cours de glisser quels bords du calque BOUGENT et
// lequel est ANCRÉ — immobile en repère local, donc un candidat d'accroche légitime — sans redériver
// ces mêmes ternaires une seconde fois et risquer de diverger de computeResizedFrame au premier
// changement de l'un des deux). Le bord ANCRÉ sur un axe est l'OPPOSÉ du bord PORTÉ : une poignée qui
// porte "e" ancre "w" (et vice versa) ; une poignée qui ne porte ni l'un ni l'autre (n/s seule) ne
// touche pas cet axe du tout.
export function handleAxes(handle: HandleId): HandleAxes {
  const hasN = handle.includes("n");
  const hasS = handle.includes("s");
  const hasE = handle.includes("e");
  const hasW = handle.includes("w");
  return { hasN, hasS, hasE, hasW, isCorner: (hasN || hasS) && (hasE || hasW) };
}

const MIN_SIZE = 1;

// Rotation 2D par la formule standard R(θ)·v (cos/sin déjà calculés pour un θ donné). Un SEUL point
// d'implémentation pour le sens de rotation : appeler `rotateVec(v, cos, sin)` pour tourner de +θ,
// ou `rotateVec(v, cos, -sin)` pour tourner de -θ (cos(-θ) = cos θ, sin(-θ) = -sin θ) — plutôt que
// deux formules à signes opposés recopiées à la main aux deux endroits où computeResizedFrame en a
// besoin, ce qui rendait un risque d'inversion de signe indétectable à la relecture (revue Tâche 1).
function rotateVec(v: Point, cos: number, sin: number): Point {
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

export interface ResizeOptions {
  /** Taille minimale d'un côté, en pixels gabarit — défaut MIN_SIZE (1px). */
  minSize?: number;
  /** Rotation ACTUELLE du calque, en degrés — défaut 0. Voir le commentaire de computeResizedFrame
   * : nécessaire dès que le calque est tourné, sinon la poignée pointe dans la mauvaise direction
   * à l'écran (Tâche 1, U2). Un objet plutôt qu'un 4e/5e paramètre positionnel : la Tâche 2 (U2)
   * ajoute encore Maj (ratio verrouillé, accroche de rotation à 15°) et Alt (redimensionner depuis
   * le centre) au-dessus de ceci, et forcer chaque appelant à épeler `MIN_SIZE` pour atteindre le
   * champ suivant ne passait déjà plus l'échelle (revue Tâche 1, Mineur 1). */
  rotationDeg?: number;
  /** Maj (Tâche 2, U2) — verrouille le ratio w/h de DÉPART. Coins seulement (voir le commentaire
   * dans computeResizedFrame juste avant son usage) : sur une poignée de bord, ce champ est ignoré. */
  lockAspectRatio?: boolean;
  /** Alt (Tâche 2, U2) — redimensionne depuis le CENTRE : les deux bords opposés bougent
   * symétriquement et le centre reste fixe, la poignée TIRÉE restant SOUS LE CURSEUR (le cadre varie
   * donc du DOUBLE du delta, pas de la moitié — revue Tâche 2, Important 2 ; ce commentaire affirmait
   * la moitié, comportement de la première version, et le correctif l'avait laissé tel quel).
   * Voir le commentaire dans computeResizedFrame juste avant son usage, pour la preuve que le centre
   * reste fixe À L'ÉCRAN quel que soit rotationDeg. */
  fromCenter?: boolean;
}

// `delta` est déjà en pixels GABARIT (converti par toCanvasCoords avant d'arriver ici), mais dans
// le repère ÉCRAN/canevas — PAS dans le repère LOCAL du calque. Les poignées sont rendues à
// l'intérieur d'un conteneur `transform: rotate(rotationDeg)` (canvas.tsx:151-161), donc dès que
// `rotationDeg !== 0`, "est" ne pointe plus vers +x écran : à 90°, par exemple, c'est +y écran qui
// pointe vers +x LOCAL. Appliquer `delta` tel quel à x/y/w/h (comme avant Tâche 1, U2) élargit donc
// le mauvais axe et fait glisser le calque au passage — non détecté jusqu'ici car la rotation est
// rare en pratique (voir tests/studio-drag.test.ts, describe "la dérive de rotation").
//
// Le correctif tient en deux étapes :
//  1. Tourner `delta` par R(-rotationDeg) pour retrouver le delta dans le repère LOCAL du calque
//     (celui où "e" pointe bien vers +x, quelle que soit la rotation affichée à l'écran) — puis
//     appliquer EXACTEMENT la même logique d'ancrage qu'avant (chaque poignée ancre le ou les
//     côtés qu'elle NE porte PAS ; le clamp au minimum préserve toujours le côté opposé à la
//     poignée tirée). Ceci calcule le bon w/h et un x/y "naïf", correct dans le repère local mais
//     pas encore sur l'écran si rotationDeg !== 0.
//  2. La rotation CSS se fait autour du CENTRE (transform-origin par défaut) : changer w/h déplace
//     donc le centre DANS LE REPÈRE LOCAL — un déplacement qui, une fois le calque affiché tourné,
//     doit lui-même être tourné par R(rotationDeg) pour connaître son effet réel à l'écran. Sans
//     cette seconde rotation, le bord que la poignée ne porte pas ("l'ancre") dérive à l'écran dès
//     que le calque est tourné (constaté empiriquement : coin/bord ancré qui bouge alors qu'il ne
//     devrait pas). En dérivant x/y du NOUVEAU centre (= ancien centre + ce déplacement tourné)
//     plutôt que du x/y naïf de l'étape 1, l'ancre reste immobile à l'écran à N'IMPORTE QUEL angle.
//
// À `rotationDeg === 0`, R(0) est l'identité : l'étape 1 restitue `delta` tel quel et l'étape 2 ne
// change rien (le déplacement local du centre égale déjà son équivalent écran) — d'où le retour
// anticipé ci-dessous, qui rend le comportement à 0° IDENTIQUE OCTET PRÈS à avant Tâche 1 (même
// chemin de code, aucune dépendance à l'arithmétique flottante de sin/cos pour ce cas).
// Tâche 2 (U2) — Maj (`lockAspectRatio`) et Alt (`fromCenter`) s'insèrent dans EXACTEMENT la même
// composition que rotationDeg ci-dessus : `local` (étape 1, delta tourné dans le repère du calque)
// est calculé UNE SEULE FOIS, puis w/h et enfin x/y en dérivent — jamais l'inverse. C'est cet ordre
// qui rend Alt correct sous rotation sans code dédié (voir le commentaire juste avant l'ancrage x/y
// ci-dessous) : appliquer un modificateur à un delta ÉCRAN puis tourner ensuite donnerait un résultat
// différent (et faux) à tout angle non nul — le plan U2 le signale explicitement.
export function computeResizedFrame(
  start: Frame,
  handle: HandleId,
  delta: Point,
  {
    minSize = MIN_SIZE,
    rotationDeg = 0,
    lockAspectRatio = false,
    fromCenter = false,
  }: ResizeOptions = {},
): Frame {
  const { hasN, hasS, hasE, hasW, isCorner } = handleAxes(handle);

  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // R(-rotationDeg) appliqué à `delta` — voir étape 1 ci-dessus.
  const local: Point = rotationDeg === 0 ? delta : rotateVec(delta, cos, -sin);

  // w/h/x/y NAÏFS — BIT-IDENTIQUES à la Tâche 1 (donc à avant la Tâche 2) : ce bloc ne change JAMAIS,
  // quels que soient les modificateurs ci-dessous. `x`/`y` n'y sont fixés QUE pour la poignée qui
  // porte cet axe (hasW/hasN), via `local.x`/`local.y` DIRECTEMENT — jamais via une forme dérivée de
  // `w`/`h` — car `start.w − (start.w − local.x)` n'est PAS garanti reproduire `local.x` bit à bit
  // pour un delta fractionnaire non représentable exactement en binaire (revue Tâche 2, Important 3 :
  // la forme dérivée, utilisée partout dans une version antérieure, différait de l'ordre de 1e-14px
  // sur 1017/9984 cas — `screenDelta` divise par une échelle fractionnaire, donc un delta non
  // représentable est le cas NORMAL, pas un cas limite). La forme dérivée n'est réintroduite plus bas
  // QUE là où Maj ou le clamp ont RÉELLEMENT changé `w`/`h` — jamais sur ce chemin par défaut.
  let { x, y, w, h } = start;
  if (hasE) w = start.w + local.x;
  if (hasW) { w = start.w - local.x; x = start.x + local.x; }
  if (hasS) h = start.h + local.y;
  if (hasN) { h = start.h - local.y; y = start.y + local.y; }

  // Maj — ratio verrouillé, COINS SEULEMENT (`isCorner` ; voir le commentaire de `lockAspectRatio`
  // dans ResizeOptions pour le choix documenté sur les poignées de bord). PROJECTION CONTINUE du
  // delta local sur la diagonale (start.w, start.h) — pas un choix discret d'« axe dominant » : `t`
  // est le scalaire tel que faire évoluer w ET h par le MÊME facteur (1+t) reproduit la composante du
  // delta le long de cette diagonale (la composante perpendiculaire, elle, romprait le ratio et est
  // donc ignorée). w = start.w·(1+t) et h = start.h·(1+t) donnent w/h = start.w/start.h EXACTEMENT,
  // par construction, pour toute valeur de `t` — donc CONTINU en local.x/local.y, sans branche.
  //
  // Une comparaison DISCRÈTE (« |local.x| ≥ |local.y| ? l'axe X domine : l'axe Y domine », utilisée
  // dans une version antérieure de ce correctif) produit un SAUT à la frontière |local.x| = |local.y|,
  // car chaque côté de la frontière dérive l'AUTRE dimension d'un axe différent — deux calculs
  // indépendants qui ne coïncident qu'exactement À la frontière (jusqu'à 198px d'écart mesurés à un
  // pas de 0,05° sur un balayage circulaire, revue Tâche 2, Critique 1). La projection continue n'a
  // pas ce problème : une seule formule, linéaire en local.x/local.y — voir tests/studio-drag.test.ts,
  // describe "continuité".
  //
  // Une alternative (« axe dominant sur les variations RELATIVES SIGNÉES », proposée puis testée et
  // REJETÉE lors de la revue de ce correctif, F1) a été écartée pour trois raisons, à garder ici pour
  // qu'un futur lecteur ne rouvre pas le débat sans les revoir :
  //  1. Sur un glisser le long de la DIAGONALE de la boîte — le geste Maj-coin le plus naturel — la
  //     projection et l'alternative « max » coïncident bit à bit (ex. 260×195 pour un delta (60,45) sur
  //     une boîte 200×150) : l'écart n'apparaît QUE quand la direction du glisser diverge du ratio
  //     verrouillé, cas où un compromis est de toute façon obligatoire (le curseur n'est génériquement
  //     PAS sur la droite de contrainte sous Maj, contrairement à Alt — voir raison 2).
  //  2. L'analogie avec l'invariant de manipulation directe d'Alt (Important 2) ne tient PAS : Alt peut
  //     garder la poignée EXACTEMENT sous le curseur parce que rien d'autre ne contraint sa position.
  //     Sous Maj, le curseur est généralement HORS de la droite ratio-verrouillée — « la poignée sous
  //     le curseur » est alors géométriquement impossible, et la seule question qui reste est QUEL point
  //     de cette droite choisir. La projection orthogonale est ce choix ; « suivre le curseur » n'en est
  //     pas un candidat valide ici.
  //  3. L'alternative testée NE PEUT PAS rétrécir : un glisser (−60,0) sur la même boîte 200×150 laisse
  //     le cadre totalement inchangé (200×150), et un glisser purement vertical vers l'intérieur fait de
  //     même — sous Maj tenu, il deviendrait impossible de rétrécir une boîte en ne tirant que sur un
  //     axe. La variante intermédiaire (axe dominant sur les valeurs relatives, qui est le bon diagnostic
  //     du bug original) saute encore de 140,0 à 260,0px de part et d'autre de l'anti-diagonale. La
  //     projection, elle, est continue PARTOUT, symétrique en rétrécissement comme en agrandissement,
  //     exacte sur le ratio et monotone — sans cas d'échec connu.
  let aspectLocked = false;
  if (lockAspectRatio && isCorner) {
    const d2 = start.w * start.w + start.h * start.h;
    if (d2 > 0) {
      const t = ((hasE ? local.x : -local.x) * start.w + (hasS ? local.y : -local.y) * start.h) / d2;
      w = start.w * (1 + t);
      h = start.h * (1 + t);
      aspectLocked = true;
    }
  }

  // Alt — redimensionne depuis le CENTRE. Choix (revue Tâche 2, Important 2 — la première version de
  // ce modificateur faisait avancer la poignée tirée à MI-VITESSE du curseur ; la revue a établi que
  // Figma/Sketch/Illustrator/Photoshop gardent tous la poignée SOUS LE CURSEUR, comme un glisser
  // normal, et a tranché pour aligner sur cet usage majoritaire plutôt que sur une propriété que rien
  // ne demandait) : la poignée TIRÉE reste donc SOUS LE CURSEUR, exactement comme un glisser normal
  // (la propriété de manipulation directe déjà établie par la Tâche 1 pour le chemin sans
  // modificateur) ; le bord OPPOSÉ se déplace en MIROIR pour garder le centre fixe. Doubler l'écart à
  // `start` avant de dériver x/y plus
  // bas est ce qui produit ce résultat : si w0/h0 est le w/h « un seul bord bouge » déjà calculé
  // ci-dessus (delta local direct, éventuellement ajusté par Maj juste au-dessus), alors w = start.w +
  // 2·(w0 − start.w) place le bord tiré à start + (w0−start.w) — IDENTIQUE au glisser normal — et le
  // bord opposé à start − (w0−start.w) (miroir) ; la taille totale change donc de 2·(w0−start.w), pas
  // de (w0−start.w). Ceci compose avec Maj sans code séparé : w0/h0 (verrouillés ou non) valent tous
  // deux `start.*·(1+t)` pour un même `t`, donc `start.* + 2·(start.*·(1+t) − start.*)` se simplifie en
  // `start.*·(1+2t)` pour les DEUX dimensions — le ratio reste donc préservé après doublement.
  if (fromCenter) {
    w = 2 * w - start.w;
    h = 2 * h - start.h;
  }

  // Clamp — tient compte du ratio verrouillé quand Maj a RÉELLEMENT changé w/h (sinon un calque très
  // fin type 1000×10 partirait hors-ratio dès que le glisser atteint le clamp — revue Tâche 2,
  // "cheap"). `floorScale` est le facteur d'échelle commun aux deux axes qui satisfait `minSize` sur
  // CHACUN d'eux (`minSize/start.w` pour l'axe W, `minSize/start.h` pour l'axe H — le plus grand des
  // deux gagne, puisqu'un seul facteur s'applique aux deux dimensions à la fois) — `minW`/`minH` s'en
  // déduisent (`start.w·floorScale`, `start.h·floorScale`), ce qui garantit `minW/minH === start.w/
  // start.h` : les DEUX dimensions atteignent leur plancher respectif AU MÊME facteur, jamais une
  // seule, jamais un ratio brisé au plancher.
  //
  // `Math.min(1, …)` — revue Tâche 2, F2 : SANS ce plafond, un calque de départ déjà plus fin qu'un
  // seul pixel sur un axe (état légal du schéma — `z.number().positive()` interdit `0`, pas les
  // sous-pixels) exige un `floorScale` > 1 pour satisfaire `minSize` sur cet axe, ce qui geste après
  // geste GONFLE l'AUTRE axe dans des proportions absurdes (`{w:0.5,h:150}` + un glisser de 0,001px
  // renvoyait `h:300`, doublant la hauteur pour un geste qui ne change presque rien) — y compris pour
  // un geste qui RÉTRÉCIT à peine. Le clamp existe pour empêcher un geste de RÉTRÉCIR sous `minSize`,
  // jamais pour AGRANDIR le calque au-delà de sa taille de départ : plafonner `floorScale` à 1 rend
  // cette propriété vraie par construction (`minW ≤ start.w`, `minH ≤ start.h`, TOUJOURS), et pour un
  // calque déjà dans les proportions normales (les deux axes ≥ `minSize`) le plafond ne joue aucun
  // rôle, puisque `floorScale` y est de toute façon très inférieur à 1.
  //
  // `start.w > 0` s'ajoute à `start.h > 0` (Tâche 2, F2) : sans lui, `start.w === 0` fait diverger
  // `minSize/start.w` vers `Infinity`, qui *survivrait* techniquement au `Math.min(1, …)` (`w` neutre)
  // mais reste fragile à documenter comme une garde explicite plutôt que de compter sur l'arithmétique
  // IEEE754 de l'infini pour s'annuler correctement à chaque futur remaniement.
  let clampedW = false;
  let clampedH = false;
  if (aspectLocked && start.w > 0 && start.h > 0) {
    const floorScale = Math.min(1, Math.max(minSize / start.w, minSize / start.h));
    const minW = start.w * floorScale;
    const minH = start.h * floorScale;
    if (w < minW) { w = minW; clampedW = true; }
    if (h < minH) { h = minH; clampedH = true; }
  } else {
    if (w < minSize) { w = minSize; clampedW = true; }
    if (h < minSize) { h = minSize; clampedH = true; }
  }

  // x/y : Alt ancre le CENTRE local (voir plus haut pour la preuve que cela suffit à garder le centre
  // fixe À L'ÉCRAN aussi, à n'importe quel angle : la formule replace TOUJOURS le centre local
  // exactement là où il était — `x + w/2 = centerX − w/2 + w/2 = centerX`, quel que soit `w` —, donc
  // l'étape 2 plus bas, qui ne fait que tourner le DÉPLACEMENT du centre local, reçoit un déplacement
  // nul). Sinon, l'ancrage par défaut de la Tâche 1 s'applique — mais dérivé du w/h FINAL UNIQUEMENT
  // sur L'AXE que Maj ou le clamp ont RÉELLEMENT changé (revue Tâche 2, F3 : `clampedW`/`clampedH`
  // SÉPARÉS, pas un seul `clamped` combiné — un `clamped` unique dérivait `y` d'un `h` inchangé chaque
  // fois que SEUL `w` clampait sur une poignée d'angle sans Maj, ce qui réintroduisait la même perte de
  // bit-identité qu'Important 3 avait fermée sur l'AUTRE axe : `start.h − (start.h − local.y)` n'égale
  // `local.y` qu'à l'arrondi flottant près). Sur le chemin par défaut pour un axe donné (ni Maj, ni
  // clamp sur CET axe), x ou y garde sa valeur NAÏVE posée tout en haut, bit-identique à la Tâche 1.
  if (fromCenter) {
    const centerX = start.x + start.w / 2;
    const centerY = start.y + start.h / 2;
    x = centerX - w / 2;
    y = centerY - h / 2;
  } else {
    if (hasW && (aspectLocked || clampedW)) x = start.x + (start.w - w);
    if (hasN && (aspectLocked || clampedH)) y = start.y + (start.h - h);
  }

  if (rotationDeg === 0) return { x, y, w, h };

  // Étape 2 : le centre a bougé DANS LE REPÈRE LOCAL (localShift) — on le tourne par R(rotationDeg)
  // pour obtenir son déplacement réel à l'écran, puis on re-dérive x/y du nouveau centre plutôt que
  // de garder le x/y "naïf" calculé ci-dessus.
  const oldCenter: Point = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
  const localCenter: Point = { x: x + w / 2, y: y + h / 2 };
  const localShift: Point = { x: localCenter.x - oldCenter.x, y: localCenter.y - oldCenter.y };
  const screenShift: Point = rotateVec(localShift, cos, sin); // R(+rotationDeg) — voir étape 2 ci-dessus.
  return {
    x: oldCenter.x + screenShift.x - w / 2,
    y: oldCenter.y + screenShift.y - h / 2,
    w,
    h,
  };
}

export interface RotationOptions {
  /** Maj (Tâche 2, U2) — arrondit l'angle RÉSULTANT (startDeg + delta de geste, pas seulement le
   * delta) au multiple de ROTATION_SNAP_DEG le plus proche. Défaut false : comportement inchangé. */
  snap?: boolean;
}

const ROTATION_SNAP_DEG = 15;

// L'angle est invariant par mise à l'échelle uniforme (atan2(dy/k, dx/k) === atan2(dy, dx) pour
// k > 0) : center/start/current peuvent donc être fournis dans N'IMPORTE QUEL espace cohérent
// (écran ou gabarit), du moment que les trois le sont dans le MÊME — pas besoin de conversion
// d'échelle ici, contrairement au déplacement et au redimensionnement.
export function computeRotationDeg(
  center: Point,
  start: Point,
  current: Point,
  startDeg: number,
  { snap = false }: RotationOptions = {},
): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(current.y - center.y, current.x - center.x);
  const raw = startDeg + (a1 - a0) * (180 / Math.PI);
  if (!snap) return raw;
  // Accroche l'angle RÉSULTANT, pas le delta de geste : un calque déjà à une rotation quelconque
  // (héritée d'un geste précédent sans Maj) atterrit malgré tout sur un multiple net de 15° dès que
  // Maj est tenu, ce qui correspond à l'attente « rendre cette rotation propre » plutôt qu'à
  // « ajouter un incrément propre à une valeur de départ qui peut être n'importe quoi ».
  const snapped = Math.round(raw / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
  // `Math.round(x)` renvoie `-0` (pas `0`) pour tout `x` dans [-0.5, -0) — un angle brut dans
  // (−7.5, 0] accrocherait donc sur "-0°" plutôt que "0°" sans cette normalisation (revue Tâche 2,
  // cheap). `-0 === 0` en JS donc sans conséquence numérique, mais `-0` peut fuiter tel quel dans un
  // affichage ou une sérialisation JSON (`"-0°"`) — `snapped === 0` est vrai pour les DEUX zéros, donc
  // ce test normalise l'un vers l'autre sans jamais toucher une valeur non nulle.
  return snapped === 0 ? 0 : snapped;
}

const NUDGE_STEP = 1;
const NUDGE_STEP_SHIFT = 10;

export function nudgeDelta(key: string, shift: boolean): Point | null {
  const step = shift ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  switch (key) {
    case "ArrowLeft": return { x: -step, y: 0 };
    case "ArrowRight": return { x: step, y: 0 };
    case "ArrowUp": return { x: 0, y: -step };
    case "ArrowDown": return { x: 0, y: step };
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Machine à geste PURE. Un SEUL geste (pointerdown -> N pointermove -> pointerup) ne committe
// QU'UNE SEULE action au réducteur, au pointerup — les pointermove intermédiaires ne font que
// mettre à jour un aperçu local (onPreviewChange), jamais le réducteur. C'est ce qui garantit
// « un geste = une entrée d'historique » sans rien redemander au réducteur (lib/studio/editor-state
// pousse déjà exactement une entrée par commit() réussi — encore faut-il ne l'appeler qu'une fois).

export interface DragPreview {
  layerId: string;
  frame?: Frame;
  rotation?: number;
  /** Tâche 5 (U2, spec §5) — les guides d'accrochage allumés par CE pas de geste, en coordonnées du
   * gabarit. Ils voyagent sur le canal d'aperçu DÉJÀ existant (`onPreviewChange`), exigence explicite
   * du plan : un second canal se désynchroniserait du cadre qu'il est censé expliquer, et il faudrait
   * l'effacer à deux endroits au lieu d'un. Le champ est ABSENT (et non `[]`) quand rien n'accroche,
   * pour que l'aperçu d'un geste sans accroche reste comparable à l'octet près à celui d'avant la
   * Tâche 5 — plusieurs tests existants comparent l'objet d'aperçu entier avec `toEqual`. */
  guides?: SnapGuide[];
}

// Tâche 2 (U2) — l'état des touches Maj/Alt, lu en LIVE à chaque pointermove/pointerup (pas figé au
// pointerdown) : comme dans tout outil de conception, appuyer ou relâcher Maj/Alt PENDANT le geste
// doit changer le comportement immédiatement, aperçu compris. `shift`/`alt` omis équivaut à `false`
// pour les deux — c'est ce qui garde `move()`/`end()` appelés sans second argument (tous les appels
// d'avant la Tâche 2, dans ce fichier comme dans les tests) rigoureusement inchangés.
export interface GestureModifiers {
  shift?: boolean;
  alt?: boolean;
}

type GestureKind = "move" | "resize" | "rotate";

interface ActiveGesture {
  kind: GestureKind;
  layerId: string;
  handle?: HandleId;
  startFrame: Frame;
  startRotation: number;
  startPointer: Point;
  center?: Point;
}

// Hoisté (revue Tâche 2, cheap) : `computePreview()` et `end()` construisaient chacun le MÊME objet
// littéral — la duplication est exactement ce qui a motivé le test de câblage de la Tâche 1 (`la
// rotation du calque atteint bien le dispatch ») : deux sites qui doivent rester synchronisés à la
// main finissent par diverger. Une seule fonction, un seul endroit où `rotationDeg`/`lockAspectRatio`/
// `fromCenter` peuvent être oubliés — donc un seul endroit à vérifier.
function resizeOptionsFor(a: ActiveGesture, modifiers: GestureModifiers): ResizeOptions {
  return {
    rotationDeg: a.startRotation,
    lockAspectRatio: modifiers.shift,
    fromCenter: modifiers.alt,
  };
}

/** Ce que l'accrochage a besoin de savoir de la scène, lu en LIVE à chaque pas de geste (comme
 * `getScale`) : les calques candidats et les dimensions du plan de travail. Le moteur en retire
 * lui-même le calque manipulé et les calques masqués via `snapCandidates` (un calque VERROUILLÉ reste
 * une référence : voir la décision 2 de lib/studio/snap.ts) — l'appelant passe donc `scene.layers` tel
 * quel, sans copie de la règle de filtrage (Tâche 5). */
export interface SnapEngineContext {
  layers: readonly SnapSubject[];
  canvas: { width: number; height: number };
  /** Seuil en px ÉCRAN ; omis, `SNAP_THRESHOLD_PX` (lib/studio/snap.ts) s'applique. */
  threshold?: number;
}

export interface GestureEngineOptions {
  dispatch: Dispatch<EditorAction>;
  getScale: () => number;
  onPreviewChange: (preview: DragPreview | null) => void;
  /** Tâche 5 (U2) — OPTIONNEL, et c'est délibéré : absent (ou rendant `null`), l'accrochage est
   * entièrement désactivé et le moteur se comporte à l'octet près comme avant la Tâche 5. C'est ce qui
   * laisse inchangés les ~90 tests de geste qui construisent un moteur avec trois options. */
  getSnapContext?: () => SnapEngineContext | null;
}

export interface GestureEngine {
  beginMove(layer: Layer, pointer: Point): void;
  beginResize(layer: Layer, handle: HandleId, pointer: Point): void;
  beginRotate(layer: Layer, pointer: Point, center: Point): void;
  move(pointer: Point, modifiers?: GestureModifiers): void;
  end(pointer: Point, modifiers?: GestureModifiers): void;
  cancel(): void;
  isActive(): boolean;
}

export function createGestureEngine({
  dispatch,
  getScale,
  onPreviewChange,
  getSnapContext,
}: GestureEngineOptions): GestureEngine {
  let active: ActiveGesture | null = null;

  function screenDelta(pointer: Point, from: Point): Point {
    return toCanvasCoords({ x: pointer.x - from.x, y: pointer.y - from.y }, getScale());
  }

  /** Le contexte d'accrochage du geste en cours, candidats déjà filtrés — ou `null` quand
   * l'accrochage est désactivé (aucun `getSnapContext`, ou l'appelant rend `null`). */
  function snapFor(a: ActiveGesture) {
    const ctx = getSnapContext?.();
    if (!ctx) return null;
    return {
      candidates: snapCandidates(ctx.layers, a.layerId),
      canvas: ctx.canvas,
      // `getScale()` et non 1 : c'est ICI que le seuil en px ÉCRAN devient un seuil en px gabarit.
      // Un moteur qui passerait 1 laisserait tous les tests de lib/studio/snap.ts au vert.
      scale: getScale(),
      threshold: ctx.threshold,
    };
  }

  function begin(kind: GestureKind, layer: Layer, pointer: Point, extra?: { handle?: HandleId; center?: Point }) {
    // Un calque verrouillé « ne répond ni au clic ni au glisser » (spec §2) : le geste ne démarre
    // même pas. C'est une redondance délibérée avec le garde-fou du réducteur (moveLayer/
    // resizeLayer/rotateLayer ignorent déjà un calque locked) — celui-ci reste le VRAI filet de
    // sécurité ; celui-ci évite juste un aperçu visuel trompeur pendant le geste.
    if (layer.locked) return;
    active = {
      kind, layerId: layer.id, handle: extra?.handle, center: extra?.center,
      startFrame: layer.frame, startRotation: layer.rotation ?? 0, startPointer: pointer,
    };
  }

  function beginMove(layer: Layer, pointer: Point) {
    begin("move", layer, pointer);
  }
  function beginResize(layer: Layer, handle: HandleId, pointer: Point) {
    begin("resize", layer, pointer, { handle });
  }
  function beginRotate(layer: Layer, pointer: Point, center: Point) {
    begin("rotate", layer, pointer, { center });
  }

  /** Le résultat d'un pas de geste — pour l'aperçu ET pour le commit, calculé par UNE SEULE fonction.
   * Avant la Tâche 5, `computePreview` et `end` recalculaient chacun le cadre de leur côté ; l'accroche
   * rend cette duplication intenable, puisque le cadre COMMITTÉ doit être celui que l'utilisateur a vu
   * en aperçu, guides compris. (Même motif que le `resizeOptionsFor` hoisté par la revue Tâche 2 : deux
   * sites à garder synchronisés à la main finissent par diverger.) */
  interface GestureOutcome {
    frame?: Frame;
    rotation?: number;
    guides: SnapGuide[];
    /** Déplacement uniquement : le cadre AVANT accroche et le delta brut — `end` en a besoin pour
     * choisir entre le chemin historique (`moveLayer` avec le delta tel quel, bit-identique à avant la
     * Tâche 5) et le chemin accroché (`setFrames` avec le cadre exact). */
    rawFrame?: Frame;
    delta?: Point;
  }

  function computeGesture(a: ActiveGesture, pointer: Point, modifiers: GestureModifiers): GestureOutcome {
    if (a.kind === "move") {
      const d = screenDelta(pointer, a.startPointer);
      const rawFrame: Frame = { ...a.startFrame, x: a.startFrame.x + d.x, y: a.startFrame.y + d.y };
      const snap = snapFor(a);
      if (!snap) return { frame: rawFrame, rawFrame, delta: d, guides: [] };
      const { frame, guides } = snapMove({ frame: rawFrame, ...snap });
      return { frame, rawFrame, delta: d, guides };
    }
    if (a.kind === "resize") {
      const d = screenDelta(pointer, a.startPointer);
      const options = resizeOptionsFor(a, modifiers);
      // Le `probe` de l'accrochage : `computeResizedFrame` liée à CE geste, modificateurs compris. Les
      // options passent donc par le MÊME chemin que l'appel final — un modificateur oublié ici serait
      // oublié dans les deux, jamais dans un seul (voir lib/studio/snap.ts, décisions 4 et 6).
      const probe = (delta: Point) => computeResizedFrame(a.startFrame, a.handle!, delta, options);
      const snap = snapFor(a);
      if (!snap) return { frame: probe(d), guides: [] };
      const { delta, guides } = snapResize({
        probe, delta: d, axes: handleAxes(a.handle!), rotationDeg: a.startRotation, ...snap,
      });
      return { frame: probe(delta), guides };
    }
    // rotate — pas de conversion d'échelle : l'angle est invariant (voir computeRotationDeg). Aucun
    // accrochage de position : Maj accroche déjà l'ANGLE par multiples de 15° (Tâche 2).
    const rotation = computeRotationDeg(a.center!, a.startPointer, pointer, a.startRotation, { snap: modifiers.shift });
    return { rotation, guides: [] };
  }

  function previewFrom(a: ActiveGesture, outcome: GestureOutcome): DragPreview {
    const preview: DragPreview = { layerId: a.layerId };
    if (outcome.frame) preview.frame = outcome.frame;
    if (outcome.rotation !== undefined) preview.rotation = outcome.rotation;
    // Champ ABSENT quand rien n'accroche — voir le commentaire de `DragPreview.guides`.
    if (outcome.guides.length > 0) preview.guides = outcome.guides;
    return preview;
  }

  function move(pointer: Point, modifiers: GestureModifiers = {}) {
    if (!active) return;
    onPreviewChange(previewFrom(active, computeGesture(active, pointer, modifiers)));
  }

  function end(pointer: Point, modifiers: GestureModifiers = {}) {
    if (!active) return;
    const a = active;
    active = null;
    onPreviewChange(null); // efface aussi les guides : un seul canal, un seul effacement.

    const outcome = computeGesture(a, pointer, modifiers);

    if (a.kind === "move") {
      const d = outcome.delta!;
      const frame = outcome.frame!;
      if (outcome.rawFrame && !sameFrame(outcome.rawFrame, frame)) {
        // Le déplacement a ACCROCHÉ : on committe le CADRE, pas le delta. `moveLayer` ajouterait le
        // delta au cadre courant, et `x + (cible − x)` ne rend pas `cible` au bit près en arithmétique
        // flottante — le calque atterrirait à ~1e-14px de la ligne que le guide vient d'annoncer.
        // `setFrames` (Tâche 4) pose le cadre tel quel, en UNE entrée d'historique, et ignore de toute
        // façon un calque verrouillé comme `moveLayer`.
        dispatch(setFrames([{ id: a.layerId, frame }]));
      } else if (d.x !== 0 || d.y !== 0) {
        // Chemin historique, BIT-IDENTIQUE à avant la Tâche 5 (y compris « un clic sans déplacement ne
        // committe rien »).
        dispatch(moveLayer(a.layerId, d.x, d.y));
      }
    } else if (a.kind === "resize") {
      dispatch(resizeLayer(a.layerId, outcome.frame!));
    } else {
      dispatch(rotateLayer(a.layerId, outcome.rotation!));
    }
  }

  function cancel() {
    active = null;
    onPreviewChange(null);
  }

  function isActive() {
    return active !== null;
  }

  return { beginMove, beginResize, beginRotate, move, end, cancel, isActive };
}

// ─────────────────────────────────────────────────────────────────────────────
// Le hook React : relie la machine PURE ci-dessus à de vrais événements pointeur. Non exercé par
// `bun test` (pas de DOM disponible) — voir le rapport de tâche pour le détail de cette limite
// assumée ; toute la logique de geste qui compte a déjà été vérifiée ci-dessus, indépendamment de
// React et du DOM.
export function useLayerDrag(
  dispatch: Dispatch<EditorAction>,
  scale: number,
  /** Tâche 5 (U2) — omis ou `null` : aucun accrochage (comportement d'avant la Tâche 5). Relu par
   * référence à chaque pas de geste, donc un objet reconstruit à chaque rendu ne réarme rien. */
  snap?: SnapEngineContext | null,
) {
  const [preview, setPreview] = useState<DragPreview | null>(null);

  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const engineRef = useRef<GestureEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createGestureEngine({
      dispatch: (action) => dispatchRef.current(action),
      getScale: () => scaleRef.current,
      onPreviewChange: setPreview,
      getSnapContext: () => snapRef.current ?? null,
    });
  }
  const engine = engineRef.current;

  // Un seul point d'entrée pour armer la capture pointeur + les gestionnaires move/up/cancel sur
  // L'ÉLÉMENT CIBLÉ lui-même : `setPointerCapture` route tous les événements suivants vers cet
  // élément même si le pointeur sort de ses limites pendant le geste, donc pas besoin d'écouteurs
  // globaux sur `window`.
  const bind = useCallback((onDown: (pointer: Point) => void) => {
    return (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      onDown({ x: e.clientX, y: e.clientY });
      const target = e.currentTarget;
      target.setPointerCapture?.(e.pointerId);

      // Maj/Alt (Tâche 2, U2) sont lus en LIVE sur CHAQUE événement pointeur (pas capturés une fois
      // au pointerdown) : `PointerEvent.shiftKey`/`.altKey` reflètent l'état des touches au moment
      // précis de l'événement, ce qui laisse l'utilisateur appuyer/relâcher les modificateurs en
      // plein geste, aperçu compris — non exercé par `bun test` (pas de DOM, voir le commentaire de
      // useLayerDrag ci-dessus), mais `createGestureEngine.move`/`.end` (qui reçoivent ces valeurs)
      // le sont directement.
      const handleMove = (ev: PointerEvent) =>
        engine.move({ x: ev.clientX, y: ev.clientY }, { shift: ev.shiftKey, alt: ev.altKey });
      const handleUp = (ev: PointerEvent) => {
        engine.end({ x: ev.clientX, y: ev.clientY }, { shift: ev.shiftKey, alt: ev.altKey });
        cleanup();
      };
      const handleCancel = () => {
        engine.cancel();
        cleanup();
      };
      function cleanup() {
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        target.removeEventListener("pointercancel", handleCancel);
      }
      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
      target.addEventListener("pointercancel", handleCancel);
    };
  }, [engine]);

  const getMoveHandler = useCallback((layer: Layer) => bind((p) => engine.beginMove(layer, p)), [bind, engine]);
  const getResizeHandler = useCallback(
    (layer: Layer, handle: HandleId) => bind((p) => engine.beginResize(layer, handle, p)),
    [bind, engine],
  );
  const getRotateHandler = useCallback(
    (layer: Layer, center: Point) => bind((p) => engine.beginRotate(layer, p, center)),
    [bind, engine],
  );

  return { preview, getMoveHandler, getResizeHandler, getRotateHandler };
}
