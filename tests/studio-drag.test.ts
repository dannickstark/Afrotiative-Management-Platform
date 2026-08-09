import { describe, it, expect } from "bun:test";
import type { Scene, Layer, Frame } from "@/lib/studio/scene";
import { editorReducer, initEditorState, type EditorAction } from "@/lib/studio/editor-state";
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
