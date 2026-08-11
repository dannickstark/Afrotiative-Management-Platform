import { describe, it, expect } from "bun:test";
import type { Scene, Layer, Frame } from "@/lib/studio/scene";
import { editorReducer, initEditorState, type EditorAction, type Point } from "@/lib/studio/editor-state";
import {
  computeResizedFrame,
  computeRotationDeg,
  nudgeDelta,
  createGestureEngine,
  HANDLES,
  type DragPreview,
  type HandleId,
} from "@/hooks/use-layer-drag";

// Pas de DOM dans `bun test` (même convention que hooks/use-persisted-filters.ts) : le hook React
// lui-même (pointerdown réels, setPointerCapture, getBoundingClientRect) n'est pas monté ici. Tout
// ce qui compte — la conversion écran -> gabarit, le clamp de taille minimale, l'angle de rotation,
// et surtout le nombre d'actions committées au réducteur par geste — vit dans createGestureEngine,
// une machine à état PURE que le hook ne fait qu'appeler depuis ses gestionnaires DOM. C'est cette
// machine qu'on teste directement, avec de simples objets {x,y} en guise d'événements pointeur.

function makeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: "l1", name: "Calque", visible: true, locked: false,
    frame: { x: 100, y: 100, w: 200, h: 150 },
    type: "shape", shape: "rect", fill: "#CCCCCC",
    ...overrides,
  } as Layer;
}

function makeScene(layer: Layer): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [layer],
  };
}

// Harnais : un dispatch qui pousse dans un vrai editorReducer, pour que "un geste = une entrée
// d'historique" se vérifie contre le VRAI réducteur (Tâche 4), pas une simulation.
function makeHarness(layer: Layer) {
  let state = initEditorState(makeScene(layer));
  const actions: EditorAction[] = [];
  const dispatch = (action: EditorAction) => {
    actions.push(action);
    state = editorReducer(state, action);
  };
  return { dispatch, actions, getState: () => state };
}

describe("computeResizedFrame — clamp de taille minimale", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };

  it("un glisser positif énorme sur la poignée 'se' respecte un minimum de 1px, x/y inchangés", () => {
    const frame = computeResizedFrame(start, "se", { x: -5000, y: -5000 }, { minSize: 1 });
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(1);
    expect(frame.x).toBe(100);
    expect(frame.y).toBe(100);
  });

  it("la poignée 'nw' clampée à 1px garde le coin OPPOSÉ (bas-droit) fixe", () => {
    const frame = computeResizedFrame(start, "nw", { x: 5000, y: 5000 }, { minSize: 1 });
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(1);
    // Coin bas-droit d'origine : (300, 250). Doit rester identique après clamp.
    expect(frame.x + frame.w).toBe(start.x + start.w);
    expect(frame.y + frame.h).toBe(start.y + start.h);
  });

  it("un redimensionnement normal (sans dépasser le minimum) applique le delta tel quel", () => {
    const frame = computeResizedFrame(start, "se", { x: 20, y: -10 }, { minSize: 1 });
    expect(frame).toEqual({ x: 100, y: 100, w: 220, h: 140 });
  });

  it("la poignée 'e' seule ne touche jamais x/y, même clampée", () => {
    const frame = computeResizedFrame(start, "e", { x: -5000, y: 0 }, { minSize: 1 });
    expect(frame.x).toBe(start.x);
    expect(frame.y).toBe(start.y);
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(start.h);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 1 (U2) — dérive de rotation de computeResizedFrame. Les poignées sont rendues à
// l'intérieur d'un conteneur `transform: rotate(rotationDeg)` (components/studio/canvas.tsx:151-
// 161) : sur un calque tourné, "est" ne pointe plus vers +x écran. Les helpers ci-dessous tournent
// des points EUX-MÊMES, indépendamment de computeResizedFrame, pour vérifier le comportement à
// l'ÉCRAN (où l'ancre d'une poignée doit rester immobile) plutôt que de faire confiance aux
// nombres bruts du frame retourné — exactement la mise en garde du plan U2 sur ce test précis.

function rotateVector(v: Point, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

function rotatePointAround(center: Point, point: Point, deg: number): Point {
  const v = rotateVector({ x: point.x - center.x, y: point.y - center.y }, deg);
  return { x: center.x + v.x, y: center.y + v.y };
}

function centerOf(frame: Frame): Point {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

function cornerOf(frame: Frame, which: "nw" | "ne" | "sw" | "se"): Point {
  const left = frame.x, right = frame.x + frame.w;
  const top = frame.y, bottom = frame.y + frame.h;
  if (which === "nw") return { x: left, y: top };
  if (which === "ne") return { x: right, y: top };
  if (which === "sw") return { x: left, y: bottom };
  return { x: right, y: bottom };
}

function edgeMidpointOf(frame: Frame, side: "n" | "s" | "e" | "w"): Point {
  const c = centerOf(frame);
  if (side === "n") return { x: c.x, y: frame.y };
  if (side === "s") return { x: c.x, y: frame.y + frame.h };
  if (side === "e") return { x: frame.x + frame.w, y: c.y };
  return { x: frame.x, y: c.y };
}

describe("computeResizedFrame — Tâche 1 : reproduction de la dérive de rotation", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };

  // C'est LE test que la tâche demande d'écrire en premier. À 90°, +y écran est +x LOCAL (même
  // repère que celui déjà documenté par le commentaire de computeRotationDeg, mais ici avec une
  // vraie rotation plutôt qu'une invariance d'échelle) : glisser la poignée "e" d'un delta écran
  // (0, +d) doit donc élargir le calque de d. Avant le correctif de cette tâche, computeResizedFrame
  // ignorait rotationDeg et appliquait delta.x tel quel — or delta.x vaut 0 ici, donc RIEN ne
  // changeait : la poignée "e" était purement morte à 90° pour un glisser vertical à l'écran.
  // Vérifié manuellement contre la fonction d'avant correctif (voir task-1-report.md) : elle
  // retournait bien { x:100, y:100, w:200, h:150 } — identique à `start` — pour cet appel.
  it("glisser la poignée 'e' d'un delta écran (0,+d) à 90° élargit le calque de d", () => {
    const d = 40;
    const frame = computeResizedFrame(start, "e", { x: 0, y: d }, { rotationDeg: 90 });
    expect(frame.w).toBeCloseTo(start.w + d, 9);
    expect(frame.h).toBeCloseTo(start.h, 9);
  });
});

describe("computeResizedFrame — rotation 0 : identique octet pour octet à avant Tâche 1", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };

  // Garde de non-régression la plus importante de cette tâche : passer rotationDeg=0 (ou l'omettre,
  // comme le fait chaque test du bloc "clamp de taille minimale" ci-dessus, qui reste inchangé et
  // sert lui aussi de garde) doit produire EXACTEMENT le même résultat qu'avant l'ajout du 5e
  // paramètre — computeResizedFrame emprunte d'ailleurs un retour anticipé dédié à ce cas précis.
  it("rotationDeg=0 explicite est identique à l'omettre, et identique au comportement d'avant", () => {
    const omis = computeResizedFrame(start, "se", { x: 20, y: -10 }, { minSize: 1 });
    const explicite = computeResizedFrame(start, "se", { x: 20, y: -10 }, { rotationDeg: 0 });
    expect(explicite).toEqual(omis);
    expect(explicite).toEqual({ x: 100, y: 100, w: 220, h: 140 });
  });

  it("rotationDeg=0 sur la poignée 'nw' clampée garde le coin opposé fixe, comme avant", () => {
    const frame = computeResizedFrame(start, "nw", { x: 5000, y: 5000 }, { rotationDeg: 0 });
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(1);
    expect(frame.x + frame.w).toBe(start.x + start.w);
    expect(frame.y + frame.h).toBe(start.y + start.h);
  });
});

describe("computeResizedFrame — à 90/180/270°, un glisser mono-axe ne change que la dimension visée", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const d = 40;

  // Le delta écran qui correspond, à chaque angle, à un delta LOCAL pur (+d, 0) : R(rotationDeg)
  // appliqué à (d, 0). Élargir "e" ne doit alors changer QUE w — jamais h — quel que soit l'angle.
  it("poignée 'e' à 90° (delta écran (0,+d)) : w += d, h inchangé", () => {
    const frame = computeResizedFrame(start, "e", { x: 0, y: d }, { rotationDeg: 90 });
    expect(frame.w).toBeCloseTo(start.w + d, 9);
    expect(frame.h).toBeCloseTo(start.h, 9);
  });

  it("poignée 'e' à 180° (delta écran (-d,0)) : w += d, h inchangé", () => {
    const frame = computeResizedFrame(start, "e", { x: -d, y: 0 }, { rotationDeg: 180 });
    expect(frame.w).toBeCloseTo(start.w + d, 9);
    expect(frame.h).toBeCloseTo(start.h, 9);
  });

  it("poignée 'e' à 270° (delta écran (0,-d)) : w += d, h inchangé", () => {
    const frame = computeResizedFrame(start, "e", { x: 0, y: -d }, { rotationDeg: 270 });
    expect(frame.w).toBeCloseTo(start.w + d, 9);
    expect(frame.h).toBeCloseTo(start.h, 9);
  });
});

// Revue Tâche 1, Mineur 3 : la propriété "un glisser mono-axe ne change que la dimension visée" a
// été vérifiée ci-dessus seulement pour la poignée 'e' — la relecture a balayé les 8 poignées × 16
// angles × 11 deltas et n'a trouvé aucun écart, donc l'étendre aux 8 poignées ici est une boucle,
// pas une nouvelle logique. w/h à N'IMPORTE QUEL angle multiple de 90° ne dépend QUE du delta LOCAL
// — computeResizedFrame à rotation 0 EST déjà la définition de référence de "ce que porte chaque
// poignée" (testée par ailleurs, bloc "clamp de taille minimale"). Le delta écran qui correspond à
// ce même delta local à un angle donné est simplement ce delta local tourné de +angle (`rotateVector`
// ci-dessus) : si le correctif est correct, repasser par l'écran puis revenir au local via
// `rotationDeg` doit redonner EXACTEMENT le même w/h que la référence à rotation 0, pour LES 8
// poignées (y compris les poignées d'angle, qui portent w ET h simultanément).
describe("computeResizedFrame — à 90/180/270°, les 8 poignées reproduisent le w/h de référence à 0°", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  // Delta LOCAL non nul sur les deux axes, pour que les poignées d'angle (qui portent w ET h) soient
  // couvertes aussi bien que les poignées à un seul côté.
  const localDelta: Point = { x: 40, y: -25 };
  const reference = new Map(HANDLES.map((h) => [h, computeResizedFrame(start, h, localDelta)]));

  for (const rotation of [90, 180, 270]) {
    for (const handle of HANDLES) {
      it(`poignée '${handle}' à ${rotation}° : w/h identiques à la référence à rotation 0`, () => {
        const screenDelta = rotateVector(localDelta, rotation);
        const frame = computeResizedFrame(start, handle, screenDelta, { rotationDeg: rotation });
        const ref = reference.get(handle)!;
        expect(frame.w).toBeCloseTo(ref.w, 6);
        expect(frame.h).toBeCloseTo(ref.h, 6);
      });
    }
  }
});

describe("computeResizedFrame — le bord opposé reste fixe à l'écran (poignée à un seul côté)", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const rotation = 25; // angle quelconque, ni 0 ni un multiple de 90 — voir Tâche 1 du plan.

  it("poignée 'e' à 25° : le milieu du bord OUEST (non tiré) ne bouge pas à l'écran", () => {
    const oldWestScreen = rotatePointAround(centerOf(start), edgeMidpointOf(start, "w"), rotation);

    const localDx = 30;
    const screenDelta = rotateVector({ x: localDx, y: 0 }, rotation);
    const frame = computeResizedFrame(start, "e", screenDelta, { rotationDeg: rotation });
    const newWestScreen = rotatePointAround(centerOf(frame), edgeMidpointOf(frame, "w"), rotation);

    expect(frame.w).toBeCloseTo(start.w + localDx, 9);
    expect(newWestScreen.x).toBeCloseTo(oldWestScreen.x, 6);
    expect(newWestScreen.y).toBeCloseTo(oldWestScreen.y, 6);
  });

  it("poignée 'n' à 25° : le milieu du bord SUD (non tiré) ne bouge pas à l'écran", () => {
    const oldSouthScreen = rotatePointAround(centerOf(start), edgeMidpointOf(start, "s"), rotation);

    const localDy = -20; // "n" réduit h de local.y : delta négatif -> h grandit.
    const screenDelta = rotateVector({ x: 0, y: localDy }, rotation);
    const frame = computeResizedFrame(start, "n", screenDelta, { rotationDeg: rotation });
    const newSouthScreen = rotatePointAround(centerOf(frame), edgeMidpointOf(frame, "s"), rotation);

    expect(frame.h).toBeCloseTo(start.h - localDy, 9);
    expect(newSouthScreen.x).toBeCloseTo(oldSouthScreen.x, 6);
    expect(newSouthScreen.y).toBeCloseTo(oldSouthScreen.y, 6);
  });
});

describe("computeResizedFrame — minSize clampe toujours, et garde le bon coin ancré même tourné", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const rotation = 60;

  // Même scénario que le test "clamp de taille minimale" > "poignée 'nw' clampée..." plus haut
  // (delta LOCAL (5000,5000), poignée 'nw', clampe les deux dimensions à 1), mais le delta est
  // fourni ici en repère ÉCRAN pour un calque tourné à 60° — R(60°) appliqué à (5000,5000). Le
  // coin OPPOSÉ à la poignée tirée ('nw' ancre toujours le coin bas-droit, 'se') doit rester fixe
  // à l'écran, exactement comme à rotation 0, où c'était déjà le cas (voir le test non modifié).
  it("poignée 'nw', delta énorme, à 60° : w et h clampent à 1, le coin 'se' reste fixe à l'écran", () => {
    const oldSeScreen = rotatePointAround(centerOf(start), cornerOf(start, "se"), rotation);

    const screenDelta = rotateVector({ x: 5000, y: 5000 }, rotation);
    const frame = computeResizedFrame(start, "nw", screenDelta, { rotationDeg: rotation });
    const newSeScreen = rotatePointAround(centerOf(frame), cornerOf(frame, "se"), rotation);

    expect(frame.w).toBeCloseTo(1, 9);
    expect(frame.h).toBeCloseTo(1, 9);
    expect(newSeScreen.x).toBeCloseTo(oldSeScreen.x, 6);
    expect(newSeScreen.y).toBeCloseTo(oldSeScreen.y, 6);
  });
});

describe("computeResizedFrame — poignée d'angle à 37° : les coins tournés correspondent à l'attendu", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const rotation = 37; // angle quelconque, choisi par le plan U2 pour ce test précis.
  const screenDelta: Point = { x: 15, y: -22 }; // delta écran arbitraire, non aligné sur un axe.

  // On tourne les coins NOUS-MÊMES ici (pas le frame retourné tel quel) : c'est ce qui rend ce test
  // représentatif du comportement à l'ÉCRAN plutôt que de la seule arithmétique interne de
  // computeResizedFrame (mise en garde explicite du plan U2 pour ce test).
  it("le coin opposé (nw) reste fixe à l'écran, et le coin tiré (se) suit exactement le curseur", () => {
    const oldNwScreen = rotatePointAround(centerOf(start), cornerOf(start, "nw"), rotation);
    const oldSeScreen = rotatePointAround(centerOf(start), cornerOf(start, "se"), rotation);

    const frame = computeResizedFrame(start, "se", screenDelta, { rotationDeg: rotation });

    const newNwScreen = rotatePointAround(centerOf(frame), cornerOf(frame, "nw"), rotation);
    const newSeScreen = rotatePointAround(centerOf(frame), cornerOf(frame, "se"), rotation);

    // Le coin non tiré ('nw', opposé à 'se') ne doit pas avoir bougé à l'écran.
    expect(newNwScreen.x).toBeCloseTo(oldNwScreen.x, 6);
    expect(newNwScreen.y).toBeCloseTo(oldNwScreen.y, 6);

    // Le coin tiré ('se') doit avoir suivi le curseur exactement : sa position écran se déplace du
    // delta écran appliqué, ni plus ni moins — la garantie de base de la manipulation directe.
    expect(newSeScreen.x - oldSeScreen.x).toBeCloseTo(screenDelta.x, 6);
    expect(newSeScreen.y - oldSeScreen.y).toBeCloseTo(screenDelta.y, 6);
  });
});

describe("computeRotationDeg", () => {
  it("un quart de tour autour du centre ajoute 90°", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 100, y: 0 }; // à droite du centre (0°)
    const current = { x: 0, y: 100 }; // en dessous du centre (90°, axe Y vers le bas)
    expect(computeRotationDeg(center, start, current, 0)).toBeCloseTo(90, 5);
  });

  it("s'ajoute à la rotation de départ (pas la remplace)", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 100, y: 0 };
    const current = { x: 0, y: 100 };
    expect(computeRotationDeg(center, start, current, 45)).toBeCloseTo(135, 5);
  });
});

describe("nudgeDelta", () => {
  it("flèches : 1px sans Maj, 10px avec Maj", () => {
    expect(nudgeDelta("ArrowRight", false)).toEqual({ x: 1, y: 0 });
    expect(nudgeDelta("ArrowRight", true)).toEqual({ x: 10, y: 0 });
    expect(nudgeDelta("ArrowLeft", false)).toEqual({ x: -1, y: 0 });
    expect(nudgeDelta("ArrowUp", false)).toEqual({ x: 0, y: -1 });
    expect(nudgeDelta("ArrowDown", true)).toEqual({ x: 0, y: 10 });
  });

  it("une touche qui n'est pas une flèche ne produit rien", () => {
    expect(nudgeDelta("a", false)).toBeNull();
    expect(nudgeDelta("Delete", false)).toBeNull();
  });
});

describe("createGestureEngine — déplacement", () => {
  it("un glisser de 100px écran à k=0.5 déplace le calque de 200px gabarit", () => {
    const layer = makeLayer();
    const { dispatch, actions } = makeHarness(layer);
    // Objet mutable plutôt qu'un `let` réassigné dans une closure : TypeScript ne peut pas suivre
    // les mutations qui se produisent À L'INTÉRIEUR d'un appel de fonction, et rétrécirait sinon le
    // type de `preview` à `null` au moment des assertions ci-dessous (limite connue du contrôle de
    // flux TS, sans rapport avec le comportement réel testé).
    const previewBox: { current: DragPreview | null } = { current: null };
    const engine = createGestureEngine({
      dispatch, getScale: () => 0.5, onPreviewChange: (p) => { previewBox.current = p; },
    });

    engine.beginMove(layer, { x: 0, y: 0 });
    engine.move({ x: 100, y: 0 }); // aperçu live seulement, PAS de dispatch
    expect(actions).toHaveLength(0);
    expect(previewBox.current).toEqual({ layerId: "l1", frame: { x: 300, y: 100, w: 200, h: 150 } });

    engine.end({ x: 100, y: 0 });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: "moveLayer", id: "l1", dx: 200, dy: 0 });
    expect(previewBox.current).toBeNull();
  });

  it("un calque locked ne bouge pas — le geste ne démarre même pas", () => {
    const layer = makeLayer({ locked: true });
    const { dispatch, actions } = makeHarness(layer);
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginMove(layer, { x: 0, y: 0 });
    engine.move({ x: 500, y: 500 });
    engine.end({ x: 500, y: 500 });

    expect(actions).toHaveLength(0);
    expect(engine.isActive()).toBe(false);
  });

  it("un clic sans déplacement (delta nul) ne committe aucune action", () => {
    const layer = makeLayer();
    const { dispatch, actions } = makeHarness(layer);
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginMove(layer, { x: 50, y: 50 });
    engine.end({ x: 50, y: 50 });

    expect(actions).toHaveLength(0);
  });
});

describe("createGestureEngine — un geste = exactement une entrée d'historique", () => {
  it("plusieurs pointermove pendant UN glisser ne committent qu'UNE fois au réducteur", () => {
    const layer = makeLayer();
    const { dispatch, actions, getState } = makeHarness(layer);
    const before = getState();
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginMove(layer, { x: 0, y: 0 });
    engine.move({ x: 10, y: 0 });
    engine.move({ x: 30, y: 5 });
    engine.move({ x: 42, y: -8 });
    engine.move({ x: 60, y: 12 });
    engine.end({ x: 60, y: 12 });

    expect(actions).toHaveLength(1);
    const after = getState();
    expect(after.past).toHaveLength(before.past.length + 1);
    expect(after.scene.layers[0].frame).toEqual({ x: 160, y: 112, w: 200, h: 150 });
  });

  it("un redimensionnement complet (poignée) committe aussi une seule entrée", () => {
    const layer = makeLayer();
    const { dispatch, actions, getState } = makeHarness(layer);
    const before = getState();
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginResize(layer, "se", { x: 0, y: 0 });
    engine.move({ x: 5, y: 5 });
    engine.move({ x: 20, y: 15 });
    engine.end({ x: 20, y: 15 });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("resizeLayer");
    expect(getState().past).toHaveLength(before.past.length + 1);
  });

  it("une rotation complète committe aussi une seule entrée", () => {
    const layer = makeLayer();
    const { dispatch, actions, getState } = makeHarness(layer);
    const before = getState();
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });
    const center = { x: 200, y: 175 };

    engine.beginRotate(layer, { x: 300, y: 175 }, center);
    engine.move({ x: 250, y: 250 });
    engine.move({ x: 200, y: 275 });
    engine.end({ x: 200, y: 275 });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("rotateLayer");
    expect(getState().past).toHaveLength(before.past.length + 1);
  });
});

describe("createGestureEngine — redimensionnement respecte le minimum via un vrai geste", () => {
  it("un redimensionnement extrême dispatché reste bloqué à 1px", () => {
    const layer = makeLayer();
    const { dispatch, actions, getState } = makeHarness(layer);
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginResize(layer, "se", { x: 0, y: 0 });
    engine.end({ x: -10000, y: -10000 });

    expect(actions).toHaveLength(1);
    const frame = getState().scene.layers[0].frame;
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(1);
  });
});

// Revue Tâche 1, Important : tous les tests `computeResizedFrame` ci-dessus appellent la fonction
// PURE directement, avec une rotation choisie exprès pour chaque cas — aucun ne passe par
// `createGestureEngine`, où `hooks/use-layer-drag.ts` transmet RÉELLEMENT `a.startRotation` à
// l'appel (les deux seuls sites d'appel du fichier). Et comme tous les tests `createGestureEngine`
// ci-dessus utilisent `makeLayer()` SANS rotation, et qu'à rotation 0 le résultat est identique que
// le 5e paramètre soit fourni ou non, retirer `{ rotationDeg: a.startRotation }` de ces deux appels
// repasserait toute la suite au vert sans qu'aucun test ne le remarque — précisément parce que
// Tâche 2 modifie ces deux lignes pour y greffer Maj/Alt. Ce test ferme cette lacune : il exerce le
// VRAI chemin bout en bout (beginResize -> end -> dispatch), sur un calque réellement tourné.
describe("createGestureEngine — la rotation du calque atteint bien le dispatch (protection Tâche 1)", () => {
  it("beginResize+end sur un calque à 90° dispatch la frame corrigée par la rotation, pas la frame naïve", () => {
    const layer = makeLayer({ frame: { x: 100, y: 100, w: 200, h: 150 }, rotation: 90 });
    const { dispatch, actions, getState } = makeHarness(layer);
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginResize(layer, "e", { x: 0, y: 0 });
    engine.end({ x: 0, y: 40 }); // delta écran (0,+40) — le scénario de reproduction de la Tâche 1.

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "resizeLayer",
      id: "l1",
      // Valeur dérivée à la main dans task-1-report.md et confirmée indépendamment par la revue :
      // w += 40 (élargie, pas 200 inchangé comme le rendrait la frame "naïve" d'avant correctif),
      // x/y compensés pour garder le bord ouest ancré à l'écran plutôt qu'en repère local.
      frame: { x: 80, y: 120, w: 240, h: 150 },
    });
    expect(getState().scene.layers[0].frame).toEqual({ x: 80, y: 120, w: 240, h: 150 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 2 (U2) — les trois modificateurs de geste : Maj (ratio verrouillé au redimensionnement,
// accroche à 15° à la rotation) et Alt (redimensionner depuis le centre). Les deux nouveaux champs
// de ResizeOptions (`lockAspectRatio`, `fromCenter`) et la nouvelle 5e option de computeRotationDeg
// (`{ snap }`) suivent la même règle de composition que rotationDeg (Tâche 1) : le delta écran est
// D'ABORD tourné dans le repère local du calque, ENSUITE le modificateur s'applique — jamais l'ordre
// inverse. C'est cet ordre qui permet à Alt de garder le centre fixe à l'écran à N'IMPORTE QUEL
// angle sans code spécifique à la rotation (voir le commentaire de `fromCenter` dans la source).

describe("computeResizedFrame — Maj : verrouille le ratio w/h, coins seulement", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 }; // ratio 4/3
  const ratio = start.w / start.h;
  const opposite = { ne: "sw", nw: "se", se: "nw", sw: "ne" } as const;
  const corners: Array<"ne" | "nw" | "se" | "sw"> = ["ne", "nw", "se", "sw"];

  for (const handle of corners) {
    it(`poignée '${handle}', axe X dominant (|dx|>|dy|) : ratio préservé, coin opposé '${opposite[handle]}' fixe`, () => {
      const delta: Point = { x: 60, y: -8 };
      const before = cornerOf(start, opposite[handle]);
      const frame = computeResizedFrame(start, handle, delta, { lockAspectRatio: true });
      const after = cornerOf(frame, opposite[handle]);
      expect(frame.w / frame.h).toBeCloseTo(ratio, 9);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    });

    it(`poignée '${handle}', axe Y dominant (|dy|>|dx|) : ratio préservé, coin opposé '${opposite[handle]}' fixe`, () => {
      const delta: Point = { x: 8, y: -60 };
      const before = cornerOf(start, opposite[handle]);
      const frame = computeResizedFrame(start, handle, delta, { lockAspectRatio: true });
      const after = cornerOf(frame, opposite[handle]);
      expect(frame.w / frame.h).toBeCloseTo(ratio, 9);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    });
  }
});

// Décision documentée (voir task-2-report.md pour la discussion complète, y compris la réserve de la
// revue sur cette justification) : sur une poignée de BORD, Maj n'a AUCUN effet — un glisser sur un
// seul axe n'a pas de "ratio à préserver" au sens géométrique (il faudrait choisir arbitrairement
// dans quel sens et de combien faire bouger l'axe non tiré), pas une affirmation sur le comportement
// d'un outil précis. On le vérifie ici par égalité STRICTE (toEqual, pas juste "même ratio") : le
// chemin de calcul doit être EXACTEMENT le même, pas seulement produire un résultat qui ressemble.
describe("computeResizedFrame — Maj sur poignée de BORD : aucun effet (choix documenté)", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const sides: HandleId[] = ["n", "s", "e", "w"];
  for (const handle of sides) {
    it(`poignée '${handle}' : résultat identique avec ou sans Maj`, () => {
      const delta: Point = { x: 37, y: -19 };
      const withoutShift = computeResizedFrame(start, handle, delta);
      const withShift = computeResizedFrame(start, handle, delta, { lockAspectRatio: true });
      expect(withShift).toEqual(withoutShift);
    });
  }
});

describe("computeResizedFrame — Maj composé avec une rotation à 37° : ratio préservé, coin opposé fixe à l'écran", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const ratio = start.w / start.h;
  const rotation = 37;

  it("poignée 'se' à 37°, Maj tenu : ratio préservé ET le coin 'nw' (opposé) ne bouge pas à l'écran", () => {
    const screenDelta: Point = { x: 34, y: -6 };
    const oldNwScreen = rotatePointAround(centerOf(start), cornerOf(start, "nw"), rotation);

    const frame = computeResizedFrame(start, "se", screenDelta, { rotationDeg: rotation, lockAspectRatio: true });
    const newNwScreen = rotatePointAround(centerOf(frame), cornerOf(frame, "nw"), rotation);

    expect(frame.w / frame.h).toBeCloseTo(ratio, 9);
    expect(newNwScreen.x).toBeCloseTo(oldNwScreen.x, 6);
    expect(newNwScreen.y).toBeCloseTo(oldNwScreen.y, 6);
  });
});

describe("computeResizedFrame — Alt : redimensionne depuis le centre, qui reste fixe (rotation 0)", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };

  // Décision (revue Tâche 2, Important 2) : la poignée TIRÉE ('e') reste SOUS LE CURSEUR, exactement
  // comme un glisser normal (delta 40 -> le bord est avance de 40, de 300 à 340) — le bord OPPOSÉ
  // ('w', non tiré) se déplace en MIROIR (de 100 à 60, soit -40 aussi) pour garder le centre (200,175)
  // fixe. La taille totale change donc de 80 (2×40), pas de 40 — voir le commentaire source de
  // `fromCenter` pour l'algèbre complète et pourquoi la première version (poignée à mi-vitesse) a été
  // corrigée : rien ne demandait de répéter cette propriété à mi-vitesse, et les outils de référence
  // (Figma, Sketch, Illustrator, Photoshop) gardent tous la poignée sous le curseur.
  it("poignée 'e' : le bord opposé bouge en miroir, le centre est inchangé, la poignée tirée suit le curseur", () => {
    const frame = computeResizedFrame(start, "e", { x: 40, y: 0 }, { fromCenter: true });
    expect(frame).toEqual({ x: 60, y: 100, w: 280, h: 150 });
    expect(centerOf(frame)).toEqual(centerOf(start));
  });

  it("poignée 'se' (coin) : le centre est inchangé", () => {
    const frame = computeResizedFrame(start, "se", { x: 40, y: -20 }, { fromCenter: true });
    expect(frame).toEqual({ x: 60, y: 120, w: 280, h: 110 });
    expect(centerOf(frame)).toEqual(centerOf(start));
  });
});

// Preuve façon Tâche 1 : on ne fait PAS confiance aux seuls nombres du frame retourné, on tourne les
// points nous-mêmes. Le centre est un cas particulier : il est le PIVOT de la rotation CSS de sa
// propre boîte, donc sa position écran EST sa position en repère gabarit, sans rotation
// supplémentaire à appliquer — contrairement à un coin/bord, qui est OFFSET par rapport au centre.
// On le fait quand même passer par `rotatePointAround` (un point tourné autour de lui-même est une
// identité mathématique) pour rester dans le même moule que les autres preuves écran de ce fichier,
// plutôt que de comparer les deux frames "à la main" sans jamais invoquer une rotation.
describe("computeResizedFrame — Alt à 37° : le centre reste fixe à l'écran, le coin tiré suit le curseur EXACTEMENT (comme un glisser normal)", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const rotation = 37;
  const screenDelta: Point = { x: 24, y: -10 };

  it("le centre ne bouge pas à l'écran", () => {
    const frame = computeResizedFrame(start, "se", screenDelta, { rotationDeg: rotation, fromCenter: true });
    const oldCenterScreen = rotatePointAround(centerOf(start), centerOf(start), rotation);
    const newCenterScreen = rotatePointAround(centerOf(frame), centerOf(frame), rotation);
    expect(newCenterScreen.x).toBeCloseTo(oldCenterScreen.x, 6);
    expect(newCenterScreen.y).toBeCloseTo(oldCenterScreen.y, 6);
  });

  // Depuis la correction de l'Important 2 (revue), Alt ne fait plus avancer la poignée tirée à
  // mi-vitesse : elle suit le curseur EXACTEMENT, la même garantie de manipulation directe que le
  // glisser normal (voir le test "poignée d'angle à 37°" plus haut, sans Alt, qui établit cette même
  // propriété pour le chemin non modifié) — Alt n'ajoute qu'un déplacement en MIROIR du bord opposé,
  // que le test "le centre ne bouge pas" ci-dessus vérifie séparément.
  it("le coin tiré ('se') avance à l'écran EXACTEMENT du delta écran demandé — pas la moitié", () => {
    const oldSeScreen = rotatePointAround(centerOf(start), cornerOf(start, "se"), rotation);
    const frame = computeResizedFrame(start, "se", screenDelta, { rotationDeg: rotation, fromCenter: true });
    const newSeScreen = rotatePointAround(centerOf(frame), cornerOf(frame, "se"), rotation);

    expect(newSeScreen.x - oldSeScreen.x).toBeCloseTo(screenDelta.x, 6);
    expect(newSeScreen.y - oldSeScreen.y).toBeCloseTo(screenDelta.y, 6);
  });
});

// Maj+Alt combinés (voir task-2-report.md pour la justification) : redimensionner PROPORTIONNELLEMENT
// depuis le CENTRE — le ratio de départ est verrouillé (comme Maj seul) ET le centre reste fixe
// (comme Alt seul). L'ordre de composition dans la source est : ratio d'abord (agit sur w/h), centre
// ensuite (ancre x/y à partir du w/h final) — ce qui donne exactement ce comportement.
describe("computeResizedFrame — Maj+Alt combinés : redimensionnement proportionnel depuis le centre", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const ratio = start.w / start.h;

  it("à rotation 0 : le ratio est préservé ET le centre reste fixe", () => {
    const frame = computeResizedFrame(start, "se", { x: 60, y: -8 }, { lockAspectRatio: true, fromCenter: true });
    expect(frame.w / frame.h).toBeCloseTo(ratio, 9);
    expect(centerOf(frame).x).toBeCloseTo(centerOf(start).x, 9);
    expect(centerOf(frame).y).toBeCloseTo(centerOf(start).y, 9);
  });

  it("à 37° : le ratio est préservé ET le centre reste fixe à l'écran", () => {
    const rotation = 37;
    const frame = computeResizedFrame(
      start, "se", { x: 34, y: -6 }, { rotationDeg: rotation, lockAspectRatio: true, fromCenter: true },
    );
    expect(frame.w / frame.h).toBeCloseTo(ratio, 9);
    const oldCenterScreen = rotatePointAround(centerOf(start), centerOf(start), rotation);
    const newCenterScreen = rotatePointAround(centerOf(frame), centerOf(frame), rotation);
    expect(newCenterScreen.x).toBeCloseTo(oldCenterScreen.x, 6);
    expect(newCenterScreen.y).toBeCloseTo(oldCenterScreen.y, 6);
  });
});

// Garde de non-régression explicite : `lockAspectRatio`/`fromCenter` à `false` (au lieu d'omis) doit
// être RIGOUREUSEMENT identique à les omettre — les valeurs par défaut du destructuring, pas une
// branche de code séparée qui pourrait diverger.
describe("computeResizedFrame — Maj et Alt à false (ou omis) : identique à avant la Tâche 2", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };

  it("lockAspectRatio et fromCenter explicitement à false donnent le même résultat que ne pas les fournir, à 0° et 37°", () => {
    const delta: Point = { x: 20, y: -10 };
    for (const rotationDeg of [0, 37]) {
      const bare = computeResizedFrame(start, "se", delta, { rotationDeg });
      const explicitFalse = computeResizedFrame(
        start, "se", delta, { rotationDeg, lockAspectRatio: false, fromCenter: false },
      );
      expect(explicitFalse).toEqual(bare);
    }
  });
});

describe("computeRotationDeg — Maj (accroche à 15°)", () => {
  it("un angle brut proche de 100° s'arrondit à 105° avec l'accroche ; reste ~100° sans accroche", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 100, y: 0 };
    const angleDeg = 100;
    const current = {
      x: 100 * Math.cos((angleDeg * Math.PI) / 180),
      y: 100 * Math.sin((angleDeg * Math.PI) / 180),
    };

    expect(computeRotationDeg(center, start, current, 0)).toBeCloseTo(100, 5);
    expect(computeRotationDeg(center, start, current, 0, { snap: false })).toBeCloseTo(100, 5);
    expect(computeRotationDeg(center, start, current, 0, { snap: true })).toBeCloseTo(105, 5);
  });

  it("l'accroche porte sur l'angle RÉSULTANT (startDeg + delta), pas seulement sur le delta de geste", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 100, y: 0 };
    const angleDeg = 100; // delta de geste
    const current = {
      x: 100 * Math.cos((angleDeg * Math.PI) / 180),
      y: 100 * Math.sin((angleDeg * Math.PI) / 180),
    };
    // brut = startDeg(53) + delta(100) = 153 -> multiple de 15 le plus proche = 150 (écart 3, contre
    // 12 pour 165) — si l'accroche portait seulement sur le delta (100 -> 105), le résultat serait
    // 53+105=158, PAS un multiple de 15 : ce test distingue donc bien les deux interprétations.
    expect(computeRotationDeg(center, start, current, 53, { snap: true })).toBeCloseTo(150, 5);
  });

  it("sondage : pour de nombreux angles bruts, le résultat avec accroche est TOUJOURS un multiple de 15", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 100, y: 0 };
    for (let angleDeg = 0; angleDeg < 360; angleDeg += 7) {
      const current = {
        x: 100 * Math.cos((angleDeg * Math.PI) / 180),
        y: 100 * Math.sin((angleDeg * Math.PI) / 180),
      };
      const snapped = computeRotationDeg(center, start, current, 0, { snap: true });
      const nearestMultiple = Math.round(snapped / 15) * 15;
      expect(snapped).toBeCloseTo(nearestMultiple, 6);
    }
  });
});

describe("computeRotationDeg — sans Maj (options omises ou snap:false) : identique à avant la Tâche 2", () => {
  it("les cas déjà couverts avant la Tâche 2 restent identiques, avec ou sans options={}", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 100, y: 0 };
    const current = { x: 0, y: 100 };
    expect(computeRotationDeg(center, start, current, 0)).toBeCloseTo(90, 5);
    expect(computeRotationDeg(center, start, current, 0, {})).toBeCloseTo(90, 5);
    expect(computeRotationDeg(center, start, current, 0, { snap: false })).toBeCloseTo(90, 5);
    expect(computeRotationDeg(center, start, current, 45, { snap: false })).toBeCloseTo(135, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Protection Tâche 2, même raisonnement que la protection Tâche 1 ci-dessus : `createGestureEngine`
// est le SEUL endroit où `hooks/use-layer-drag.ts` relie Maj/Alt à `computeResizedFrame` /
// `computeRotationDeg` (dans `computePreview()` et `end()`). Comme aucun test `createGestureEngine`
// existant ne passe de modificateurs, oublier de les relayer depuis `move()`/`end()` repasserait toute
// la suite au vert SAUF ces tests-ci. On exerce donc le VRAI chemin (begin -> move -> end -> dispatch),
// en aperçu ET au commit, pour Maj comme pour Alt, y compris composé avec une rotation.
describe("createGestureEngine — Maj/Alt atteignent bien l'aperçu ET le dispatch (protection Tâche 2)", () => {
  it("Maj tenu pendant un redimensionnement par coin verrouille le ratio, en aperçu ET au commit", () => {
    const layer = makeLayer({ frame: { x: 100, y: 100, w: 200, h: 150 } }); // ratio 4/3
    const { dispatch, actions } = makeHarness(layer);
    const previewBox: { current: DragPreview | null } = { current: null };
    const engine = createGestureEngine({
      dispatch, getScale: () => 1, onPreviewChange: (p) => { previewBox.current = p; },
    });

    engine.beginResize(layer, "se", { x: 0, y: 0 });
    engine.move({ x: 60, y: -8 }, { shift: true });
    const previewFrame = previewBox.current!.frame!;
    // Valeurs NON codées en dur (revue Tâche 2, Critique 1 : la projection continue qui a remplacé le
    // choix discret d'axe dominant ne produit plus les mêmes chiffres que l'ancienne branche pour ce
    // delta précis — le ratio et l'ancrage restent la propriété à vérifier, pas un nombre magique).
    expect(previewFrame.w / previewFrame.h).toBeCloseTo(200 / 150, 9);
    expect(previewFrame.x).toBe(100); // 'se' n'ancre jamais x/y côté ouest/nord
    expect(previewFrame.y).toBe(100);
    // Preuve que Maj a RÉELLEMENT changé le résultat (sans Maj, ce même geste donnerait w=260, hors
    // ratio) — une mutation qui supprimerait `shift: ev.shiftKey`/`lockAspectRatio` à la source
    // laisserait ce test au vert si on ne vérifiait QUE le ratio d'un côté.
    expect(previewFrame.w).not.toBeCloseTo(260, 0);

    engine.end({ x: 60, y: -8 }, { shift: true });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action.type !== "resizeLayer") throw new Error("attendu resizeLayer");
    expect(action.frame.w / action.frame.h).toBeCloseTo(200 / 150, 9);
    expect(action.frame).toEqual(previewFrame); // même geste, même résultat en aperçu et au commit
  });

  it("Alt tenu pendant un redimensionnement garde le centre fixe, en aperçu ET au commit", () => {
    const layer = makeLayer({ frame: { x: 100, y: 100, w: 200, h: 150 } });
    const { dispatch, actions } = makeHarness(layer);
    const previewBox: { current: DragPreview | null } = { current: null };
    const engine = createGestureEngine({
      dispatch, getScale: () => 1, onPreviewChange: (p) => { previewBox.current = p; },
    });

    engine.beginResize(layer, "e", { x: 0, y: 0 });
    engine.move({ x: 40, y: 0 }, { alt: true });
    // La poignée tirée ('e') suit le curseur, le bord opposé ('w') bouge en miroir (revue Tâche 2,
    // Important 2) : w = start.w + 2×40 = 280, x recentré à 200 − 140 = 60.
    expect(previewBox.current).toEqual({ layerId: "l1", frame: { x: 60, y: 100, w: 280, h: 150 } });

    engine.end({ x: 40, y: 0 }, { alt: true });
    expect(actions).toEqual([{ type: "resizeLayer", id: "l1", frame: { x: 60, y: 100, w: 280, h: 150 } }]);
  });

  it("Maj tenu pendant une rotation accroche à un multiple de 15, en aperçu ET au commit", () => {
    const layer = makeLayer();
    const { dispatch, actions } = makeHarness(layer);
    const previewBox: { current: DragPreview | null } = { current: null };
    const engine = createGestureEngine({
      dispatch, getScale: () => 1, onPreviewChange: (p) => { previewBox.current = p; },
    });
    const center = { x: 200, y: 175 };
    const start = { x: 300, y: 175 }; // 0°
    const angleDeg = 100;
    const current = {
      x: center.x + 100 * Math.cos((angleDeg * Math.PI) / 180),
      y: center.y + 100 * Math.sin((angleDeg * Math.PI) / 180),
    };

    engine.beginRotate(layer, start, center);
    engine.move(current, { shift: true });
    expect(previewBox.current?.rotation).toBeCloseTo(105, 5);

    engine.end(current, { shift: true });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action.type !== "rotateLayer") throw new Error("attendu rotateLayer");
    expect(action.deg).toBeCloseTo(105, 5);
  });

  it("Maj sur un calque TOURNÉ à 90°, poignée de BORD : aucun effet — identique à la Tâche 1 (composition correcte)", () => {
    const layer = makeLayer({ frame: { x: 100, y: 100, w: 200, h: 150 }, rotation: 90 });
    const { dispatch, actions } = makeHarness(layer);
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginResize(layer, "e", { x: 0, y: 0 });
    engine.end({ x: 0, y: 40 }, { shift: true }); // même scénario que la protection Tâche 1.

    expect(actions).toEqual([{ type: "resizeLayer", id: "l1", frame: { x: 80, y: 120, w: 240, h: 150 } }]);
  });

  it("Maj sur un calque tourné à 37°, poignée d'ANGLE : le ratio reste préservé au travers du moteur de geste", () => {
    const layer = makeLayer({ frame: { x: 100, y: 100, w: 200, h: 150 }, rotation: 37 });
    const { dispatch, actions } = makeHarness(layer);
    const engine = createGestureEngine({ dispatch, getScale: () => 1, onPreviewChange: () => {} });

    engine.beginResize(layer, "se", { x: 0, y: 0 });
    engine.end({ x: 34, y: -6 }, { shift: true });

    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action.type !== "resizeLayer") throw new Error("attendu resizeLayer");
    expect(action.frame.w / action.frame.h).toBeCloseTo(200 / 150, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Revue conjointe Tâche 1 (durcissement) + Tâche 2 : quatre points fermés ci-dessous — Critique 1
// (continuité de Maj), Important 3 (bit-identité à delta fractionnaire), et deux correctifs "cheap"
// (le clamp tient compte du ratio, `-0` normalisé). Voir task-2-report.md pour le compte rendu complet.

// Critique 1 — la première version de Maj comparait |local.x| à |local.y| pour choisir un « axe
// dominant » : DEUX calculs indépendants de part et d'autre de la frontière |local.x| = |local.y|, qui
// ne coïncident qu'exactement À la frontière — d'où un saut mesuré jusqu'à 198px sur un balayage à
// 0,05°. La projection continue (voir le commentaire source) élimine la branche : une seule formule
// linéaire en local.x/local.y, donc continue par construction.
describe("computeResizedFrame — Maj : continuité autour de la diagonale (protection Critique 1)", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };

  // Reproduction EXACTE de l'exemple mesuré par la revue : deux deltas à 0,002 d'écart total, de part
  // et d'autre de |local.x| = |local.y| (ici à local.x=60), qui sautaient de 20px avec l'ancien choix
  // discret (260×195 -> 280.001×210.001).
  it("delta (60, 59.999) et (60, 60.001) — à peine 0,002 d'écart — ne produisent plus un saut de 20px", () => {
    const before = computeResizedFrame(start, "se", { x: 60, y: 59.999 }, { lockAspectRatio: true });
    const after = computeResizedFrame(start, "se", { x: 60, y: 60.001 }, { lockAspectRatio: true });
    expect(Math.abs(after.w - before.w)).toBeLessThan(0.01);
    expect(Math.abs(after.h - before.h)).toBeLessThan(0.01);
  });

  // Propriété générale demandée par la revue : deux deltas 0,001 d'écart (perpendiculairement à la
  // diagonale, pour être sûr de la traverser) ne doivent jamais produire des frames distantes de plus
  // de ~0,01px — testé à intervalles de 3° autour d'un cercle complet, ce qui traverse exactement les
  // quatre lignes de saut possibles (45°, 135°, 225°, 315°, toutes multiples de 3) et sert aussi de
  // garde générale de continuité partout ailleurs sur le cercle.
  it("deux deltas 0,001 d'écart ne produisent jamais des frames distantes de plus de 0,01px, à N'IMPORTE QUEL angle", () => {
    const eps = 0.0005; // 0,001 d'écart total entre d1 et d2, perpendiculairement à la diagonale
    const radius = 60;
    for (let deg = 0; deg < 360; deg += 3) {
      const rad = (deg * Math.PI) / 180;
      const base: Point = { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
      const d1: Point = { x: base.x - eps, y: base.y + eps };
      const d2: Point = { x: base.x + eps, y: base.y - eps };
      const f1 = computeResizedFrame(start, "se", d1, { lockAspectRatio: true });
      const f2 = computeResizedFrame(start, "se", d2, { lockAspectRatio: true });
      expect(Math.abs(f2.w - f1.w)).toBeLessThan(0.01);
      expect(Math.abs(f2.h - f1.h)).toBeLessThan(0.01);
    }
  });

  // Même propriété sur une poignée dont les DEUX signes sont inversés ('nw' : hasW ET hasN), pour
  // couvrir la branche `-local.x`/`-local.y` de la projection, pas seulement `+local.x`/`+local.y`.
  it("même propriété sur la poignée 'nw' (signes inversés)", () => {
    const eps = 0.0005;
    const radius = 60;
    for (let deg = 0; deg < 360; deg += 9) {
      const rad = (deg * Math.PI) / 180;
      const base: Point = { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
      const d1: Point = { x: base.x - eps, y: base.y + eps };
      const d2: Point = { x: base.x + eps, y: base.y - eps };
      const f1 = computeResizedFrame(start, "nw", d1, { lockAspectRatio: true });
      const f2 = computeResizedFrame(start, "nw", d2, { lockAspectRatio: true });
      expect(Math.abs(f2.w - f1.w)).toBeLessThan(0.01);
      expect(Math.abs(f2.h - f1.h)).toBeLessThan(0.01);
    }
  });
});

// Important 3 — la forme d'ancrage dérivée (`x = start.x + (start.w - w)`) avait été appliquée sur le
// chemin PAR DÉFAUT (sans Maj, sans clamp) pour toute la Tâche 2, alors qu'elle ne reproduit PAS bit à
// bit `x = start.x + local.x` pour un delta fractionnaire non représentable exactement en binaire —
// `screenDelta` divise par une échelle fractionnaire (hooks/use-layer-drag.ts), donc ce delta est le
// cas NORMAL, pas un cas limite. La revue a mesuré 1017/9984 cas différents (jusqu'à 5.7e-14px) à
// rotation 0 pour ce seul défaut.
describe("computeResizedFrame — rotation 0, delta FRACTIONNAIRE : identique OCTET PRÈS (protection Important 3)", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };

  it("poignée 'n', delta={0.1,0.3}, sans Maj, sans clamp : y = start.y + local.y EXACTEMENT (toBe, pas toBeCloseTo)", () => {
    const delta: Point = { x: 0.1, y: 0.3 };
    const frame = computeResizedFrame(start, "n", delta);
    expect(frame.y).toBe(start.y + delta.y);
    expect(frame.h).toBe(start.h - delta.y);
    expect(frame.x).toBe(start.x);
    expect(frame.w).toBe(start.w);
  });

  it("poignée 'w', delta={0.7,0.2}, sans Maj, sans clamp : x = start.x + local.x EXACTEMENT", () => {
    const delta: Point = { x: 0.7, y: 0.2 };
    const frame = computeResizedFrame(start, "w", delta);
    expect(frame.x).toBe(start.x + delta.x);
    expect(frame.w).toBe(start.w - delta.x);
  });
});

// Cheap 1 — clamp ratio-aware : sans lui, un diviseur très fin (ratio 100:1) perd son ratio de 99%
// dès que le glisser approche du minimum, exactement le cas que le rapport de Tâche 2 avait flagué
// comme un « edge case » non testé plutôt que traité — la revue a jugé que ça méritait mieux.
describe("computeResizedFrame — Maj + clamp minimal : le plancher respecte lui aussi le ratio verrouillé", () => {
  it("calque 1000×10 (ratio 100), glissé loin en dessous du minimum : w/h clampent ensemble à minSize*ratio / minSize", () => {
    const start: Frame = { x: 0, y: 0, w: 1000, h: 10 };
    const frame = computeResizedFrame(start, "se", { x: -2000, y: -2000 }, { lockAspectRatio: true });
    expect(frame.h).toBeCloseTo(1, 9); // minSize
    expect(frame.w).toBeCloseTo(100, 9); // minSize * ratio(100)
    expect(frame.w / frame.h).toBeCloseTo(100, 9); // le ratio de départ tient MÊME au plancher
  });
});

// Cheap 2 — garde `start.h > 0` : le clamp ratio-aware divise par `start.h` (`ratio = start.w /
// start.h`) ; sans la garde, un calque de départ à hauteur nulle ferait fuiter Infinity/NaN dans le
// frame retourné dès que le clamp intervient sur l'axe Y dominant.
describe("computeResizedFrame — Maj avec start.h === 0 : ni NaN ni Infinity ne fuient (garde ratio)", () => {
  it("poignée 'se', axe Y dominant (le cas qui divisait par ratio=Infinity avant la garde) reste fini", () => {
    const start: Frame = { x: 0, y: 0, w: 100, h: 0 };
    const frame = computeResizedFrame(start, "se", { x: 2, y: 20 }, { lockAspectRatio: true });
    expect(Number.isFinite(frame.x)).toBe(true);
    expect(Number.isFinite(frame.y)).toBe(true);
    expect(Number.isFinite(frame.w)).toBe(true);
    expect(Number.isFinite(frame.h)).toBe(true);
  });
});

// Cheap 3 — `Math.round` renvoie `-0` (pas `0`) pour tout argument dans [-0.5, -0), donc un angle brut
// dans (−7.5°, 0] accrochait sur "-0°" avant la normalisation `snapped === 0 ? 0 : snapped`.
describe("computeRotationDeg — Maj : l'accroche ne renvoie jamais -0 (protection cheap)", () => {
  it("angle brut à -3° (dans (-7.5,0]) : le résultat accroché est +0, jamais -0", () => {
    const center = { x: 0, y: 0 };
    const start = { x: 100, y: 0 };
    const angleDeg = -3;
    const current = {
      x: 100 * Math.cos((angleDeg * Math.PI) / 180),
      y: 100 * Math.sin((angleDeg * Math.PI) / 180),
    };
    const result = computeRotationDeg(center, start, current, 0, { snap: true });
    expect(result).toBe(0);
    expect(Object.is(result, -0)).toBe(false);
  });
});
