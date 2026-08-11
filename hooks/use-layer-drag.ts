"use client";

import { useRef, useState, useCallback } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent } from "react";
import type { Frame, Layer } from "@/lib/studio/scene";
import {
  moveLayer, resizeLayer, rotateLayer, toCanvasCoords,
  type EditorAction, type Point,
} from "@/lib/studio/editor-state";

// ─────────────────────────────────────────────────────────────────────────────
// Géométrie PURE — aucune dépendance à React ni au DOM. C'est ce qui rend ce fichier testable sans
// monter de composant (voir tests/studio-drag.test.ts, et la même convention que
// hooks/use-persisted-filters.ts : « pas de DOM dans bun test »).

export type HandleId = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: HandleId[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

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
   * symétriquement, la poignée tirée n'avance que de la moitié du delta, et le centre reste fixe
   * (voir le commentaire dans computeResizedFrame juste avant son usage, pour la preuve que cela
   * reste vrai à l'écran quel que soit rotationDeg). */
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
  const hasN = handle.includes("n");
  const hasS = handle.includes("s");
  const hasE = handle.includes("e");
  const hasW = handle.includes("w");
  const isCorner = (hasN || hasS) && (hasE || hasW);

  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // R(-rotationDeg) appliqué à `delta` — voir étape 1 ci-dessus.
  const local: Point = rotationDeg === 0 ? delta : rotateVec(delta, cos, -sin);

  // w/h bruts à partir du delta LOCAL — même formule qu'avant la Tâche 2, indépendante des deux
  // modificateurs ci-dessous (ils n'interviennent qu'APRÈS, jamais en modifiant `local` lui-même).
  let w = hasE ? start.w + local.x : hasW ? start.w - local.x : start.w;
  let h = hasS ? start.h + local.y : hasN ? start.h - local.y : start.h;

  // Maj — ratio verrouillé, COINS SEULEMENT (`isCorner` ; voir le commentaire de `lockAspectRatio`
  // dans ResizeOptions pour le choix documenté sur les poignées de bord, où cette branche est
  // simplement ignorée). L'axe dominant est celui dont le déplacement LOCAL est le plus grand en
  // valeur absolue : |Δw| = |local.x| et |Δh| = |local.y| TOUJOURS, quel que soit hasE/hasW ou
  // hasN/hasS (w = start.w ± local.x dans les deux cas, donc |w − start.w| = |local.x|) — c'est
  // cette invariance qui rend la comparaison directe entre local.x et local.y suffisante, sans avoir
  // à distinguer quelle poignée précise est active. L'autre dimension est alors dérivée du ratio de
  // départ (ratio > 0 toujours en pratique, donc le sens agrandir/rétrécir de l'axe dominant se
  // reporte automatiquement sur l'axe dérivé).
  if (lockAspectRatio && isCorner) {
    const ratio = start.w / start.h;
    if (Math.abs(local.x) >= Math.abs(local.y)) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
  }

  if (w < minSize) w = minSize;
  if (h < minSize) h = minSize;

  // x/y : Alt ancre le CENTRE local plutôt que le bord/coin opposé à la poignée tirée (le
  // comportement par défaut ci-dessous, dans la branche `else`, inchangé depuis la Tâche 1). Comme
  // cette formule replace TOUJOURS le centre local exactement là où il était (`localCenter.x = x +
  // w/2 = centerX − w/2 + w/2 = centerX`, quel que soit `w`), l'étape 2 plus bas — qui ne fait que
  // tourner le DÉPLACEMENT du centre local pour obtenir son équivalent écran — reçoit un déplacement
  // nul et laisse donc le centre inchangé À L'ÉCRAN AUSSI, à N'IMPORTE QUEL rotationDeg, sans qu'Alt
  // ait besoin d'un traitement particulier pour la rotation. C'est la preuve, pas une coïncidence :
  // voir tests/studio-drag.test.ts, describe "Alt à 37°..." pour la vérification indépendante.
  let x: number;
  let y: number;
  if (fromCenter) {
    const centerX = start.x + start.w / 2;
    const centerY = start.y + start.h / 2;
    x = centerX - w / 2;
    y = centerY - h / 2;
  } else {
    // Ancrage par défaut (Tâche 1, inchangé) : la poignée ancre le ou les côtés qu'elle NE porte
    // PAS. Formule EXACTEMENT équivalente à l'ancienne écriture en deux temps (assignation initiale
    // + réécriture identique dans la branche de clamp), puisque `local.x = start.w − w` tant que `w`
    // n'est pas clampé, et que le clamp réécrivait déjà `x` avec cette même formule en substituant
    // `minSize` à `w` — dériver `x`/`y` du `w`/`h` FINAL (post-clamp, post-Maj) est donc rigoureusement
    // la même valeur dans tous les cas déjà couverts par la Tâche 1, et c'est ce qui permet à Maj de
    // composer avec le clamp sans code séparé.
    x = hasW ? start.x + (start.w - w) : start.x;
    y = hasN ? start.y + (start.h - h) : start.y;
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
  return Math.round(raw / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
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

export interface GestureEngineOptions {
  dispatch: Dispatch<EditorAction>;
  getScale: () => number;
  onPreviewChange: (preview: DragPreview | null) => void;
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

export function createGestureEngine({ dispatch, getScale, onPreviewChange }: GestureEngineOptions): GestureEngine {
  let active: ActiveGesture | null = null;

  function screenDelta(pointer: Point, from: Point): Point {
    return toCanvasCoords({ x: pointer.x - from.x, y: pointer.y - from.y }, getScale());
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

  function computePreview(a: ActiveGesture, pointer: Point, modifiers: GestureModifiers): DragPreview {
    if (a.kind === "move") {
      const d = screenDelta(pointer, a.startPointer);
      return { layerId: a.layerId, frame: { ...a.startFrame, x: a.startFrame.x + d.x, y: a.startFrame.y + d.y } };
    }
    if (a.kind === "resize") {
      const d = screenDelta(pointer, a.startPointer);
      return {
        layerId: a.layerId,
        frame: computeResizedFrame(a.startFrame, a.handle!, d, {
          rotationDeg: a.startRotation,
          lockAspectRatio: modifiers.shift,
          fromCenter: modifiers.alt,
        }),
      };
    }
    // rotate — pas de conversion d'échelle : l'angle est invariant (voir computeRotationDeg).
    const rotation = computeRotationDeg(a.center!, a.startPointer, pointer, a.startRotation, { snap: modifiers.shift });
    return { layerId: a.layerId, rotation };
  }

  function move(pointer: Point, modifiers: GestureModifiers = {}) {
    if (!active) return;
    onPreviewChange(computePreview(active, pointer, modifiers));
  }

  function end(pointer: Point, modifiers: GestureModifiers = {}) {
    if (!active) return;
    const a = active;
    active = null;
    onPreviewChange(null);

    if (a.kind === "move") {
      const d = screenDelta(pointer, a.startPointer);
      if (d.x !== 0 || d.y !== 0) dispatch(moveLayer(a.layerId, d.x, d.y));
    } else if (a.kind === "resize") {
      const d = screenDelta(pointer, a.startPointer);
      dispatch(resizeLayer(a.layerId, computeResizedFrame(a.startFrame, a.handle!, d, {
        rotationDeg: a.startRotation,
        lockAspectRatio: modifiers.shift,
        fromCenter: modifiers.alt,
      })));
    } else {
      const rotation = computeRotationDeg(a.center!, a.startPointer, pointer, a.startRotation, { snap: modifiers.shift });
      dispatch(rotateLayer(a.layerId, rotation));
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
export function useLayerDrag(dispatch: Dispatch<EditorAction>, scale: number) {
  const [preview, setPreview] = useState<DragPreview | null>(null);

  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const engineRef = useRef<GestureEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createGestureEngine({
      dispatch: (action) => dispatchRef.current(action),
      getScale: () => scaleRef.current,
      onPreviewChange: setPreview,
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
