import { describe, it, expect } from "bun:test";
import type { Scene, Layer, Frame } from "@/lib/studio/scene";
import { editorReducer, initEditorState, type EditorAction, type Point } from "@/lib/studio/editor-state";
import {
  computeResizedFrame,
  computeRotationDeg,
  nudgeDelta,
  createGestureEngine,
  type DragPreview,
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
    const frame = computeResizedFrame(start, "se", { x: -5000, y: -5000 }, 1);
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(1);
    expect(frame.x).toBe(100);
    expect(frame.y).toBe(100);
  });

  it("la poignée 'nw' clampée à 1px garde le coin OPPOSÉ (bas-droit) fixe", () => {
    const frame = computeResizedFrame(start, "nw", { x: 5000, y: 5000 }, 1);
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(1);
    // Coin bas-droit d'origine : (300, 250). Doit rester identique après clamp.
    expect(frame.x + frame.w).toBe(start.x + start.w);
    expect(frame.y + frame.h).toBe(start.y + start.h);
  });

  it("un redimensionnement normal (sans dépasser le minimum) applique le delta tel quel", () => {
    const frame = computeResizedFrame(start, "se", { x: 20, y: -10 }, 1);
    expect(frame).toEqual({ x: 100, y: 100, w: 220, h: 140 });
  });

  it("la poignée 'e' seule ne touche jamais x/y, même clampée", () => {
    const frame = computeResizedFrame(start, "e", { x: -5000, y: 0 }, 1);
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
    const frame = computeResizedFrame(start, "e", { x: 0, y: d }, 1, 90);
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
    const omis = computeResizedFrame(start, "se", { x: 20, y: -10 }, 1);
    const explicite = computeResizedFrame(start, "se", { x: 20, y: -10 }, 1, 0);
    expect(explicite).toEqual(omis);
    expect(explicite).toEqual({ x: 100, y: 100, w: 220, h: 140 });
  });

  it("rotationDeg=0 sur la poignée 'nw' clampée garde le coin opposé fixe, comme avant", () => {
    const frame = computeResizedFrame(start, "nw", { x: 5000, y: 5000 }, 1, 0);
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
    const frame = computeResizedFrame(start, "e", { x: 0, y: d }, 1, 90);
    expect(frame.w).toBeCloseTo(start.w + d, 9);
    expect(frame.h).toBeCloseTo(start.h, 9);
  });

  it("poignée 'e' à 180° (delta écran (-d,0)) : w += d, h inchangé", () => {
    const frame = computeResizedFrame(start, "e", { x: -d, y: 0 }, 1, 180);
    expect(frame.w).toBeCloseTo(start.w + d, 9);
    expect(frame.h).toBeCloseTo(start.h, 9);
  });

  it("poignée 'e' à 270° (delta écran (0,-d)) : w += d, h inchangé", () => {
    const frame = computeResizedFrame(start, "e", { x: 0, y: -d }, 1, 270);
    expect(frame.w).toBeCloseTo(start.w + d, 9);
    expect(frame.h).toBeCloseTo(start.h, 9);
  });
});

describe("computeResizedFrame — le bord opposé reste fixe à l'écran (poignée à un seul côté)", () => {
  const start: Frame = { x: 100, y: 100, w: 200, h: 150 };
  const rotation = 25; // angle quelconque, ni 0 ni un multiple de 90 — voir Tâche 1 du plan.

  it("poignée 'e' à 25° : le milieu du bord OUEST (non tiré) ne bouge pas à l'écran", () => {
    const oldWestScreen = rotatePointAround(centerOf(start), edgeMidpointOf(start, "w"), rotation);

    const localDx = 30;
    const screenDelta = rotateVector({ x: localDx, y: 0 }, rotation);
    const frame = computeResizedFrame(start, "e", screenDelta, 1, rotation);
    const newWestScreen = rotatePointAround(centerOf(frame), edgeMidpointOf(frame, "w"), rotation);

    expect(frame.w).toBeCloseTo(start.w + localDx, 9);
    expect(newWestScreen.x).toBeCloseTo(oldWestScreen.x, 6);
    expect(newWestScreen.y).toBeCloseTo(oldWestScreen.y, 6);
  });

  it("poignée 'n' à 25° : le milieu du bord SUD (non tiré) ne bouge pas à l'écran", () => {
    const oldSouthScreen = rotatePointAround(centerOf(start), edgeMidpointOf(start, "s"), rotation);

    const localDy = -20; // "n" réduit h de local.y : delta négatif -> h grandit.
    const screenDelta = rotateVector({ x: 0, y: localDy }, rotation);
    const frame = computeResizedFrame(start, "n", screenDelta, 1, rotation);
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
    const frame = computeResizedFrame(start, "nw", screenDelta, 1, rotation);
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

    const frame = computeResizedFrame(start, "se", screenDelta, 1, rotation);

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
