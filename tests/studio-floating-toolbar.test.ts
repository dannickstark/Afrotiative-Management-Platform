// tests/studio-floating-toolbar.test.ts — Chantier B, Tâche 6 : la barre contextuelle flottante.
//
// Deux blocs, sur le modèle de tests/studio-groups.test.ts (module pur) + tests/studio-canvas.test.ts
// / tests/studio-interactions.test.ts (composition réelle, U0 harnais) :
//
//  1. `toolbarActionsFor` (lib/studio/toolbar-actions.ts) — AUCUN DOM, des littéraux de calques.
//  2. `FloatingToolbar` monté DANS `Canvas` (components/studio/canvas.tsx) via tests/dom-harness.ts —
//     la COMPOSITION (spec brief, leçon U1) : que la barre apparaisse RÉELLEMENT comme un FRÈRE dans
//     le conteneur mis à l'échelle, qu'un clic RÉEL sur « Dupliquer » dispatche, et qu'elle
//     disparaisse pendant un glisser — jamais déduit du seul rendu de `toolbarActionsFor` ou d'un
//     appel direct à une prop `onClick` trouvée par introspection.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import type { Layer, Scene } from "@/lib/studio/scene";
import { toolbarActionsFor, type ToolbarAction } from "@/lib/studio/toolbar-actions";
import { Canvas } from "@/components/studio/canvas";
import { installDom, mount, click, pointer } from "./dom-harness";

// ─────────────────────────────────────────────────────────────────────────────
// Bloc 1 — `toolbarActionsFor`, PUR (Étape 1 du brief).

function textLayer(overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id: "t1", name: "Texte", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 200, h: 60 },
    type: "text", content: "Bonjour",
    font: { family: "Noto Sans", size: 32, weight: 400 },
    color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    ...overrides,
  } as Layer;
}
function shapeLayer(overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id: "s1", name: "Forme", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 100, h: 100 },
    type: "shape", shape: "rect", fill: "#123456",
    ...overrides,
  } as Layer;
}
function imageLayer(overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id: "i1", name: "Image", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 100, h: 100 },
    type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
    ...overrides,
  } as Layer;
}
function qrLayer(overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id: "q1", name: "QR", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 100, h: 100 },
    type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4,
    ...overrides,
  } as Layer;
}

function kinds(actions: ToolbarAction[]): string[] {
  return actions.map((a) => a.kind);
}

describe("toolbarActionsFor — sélection VIDE", () => {
  it("renvoie [] pour une sélection vide", () => {
    expect(toolbarActionsFor([])).toEqual([]);
  });
});

describe("toolbarActionsFor — UN calque, par TYPE (anti-vacuité)", () => {
  it("texte -> police/taille/couleur/gras PUIS le socle commun", () => {
    const ks = kinds(toolbarActionsFor([textLayer()]));
    expect(ks.slice(0, 4)).toEqual(["font", "fontSize", "color", "bold"]);
    expect(ks).toContain("duplicate");
    expect(ks).toContain("delete");
    expect(ks).toContain("lock");
    expect(ks).toContain("bringForward");
    expect(ks).toContain("sendBackward");
    // Un SEUL calque -> jamais grouper/dégrouper (grouper un calque seul n'a pas de sens).
    expect(ks).not.toContain("group");
    expect(ks).not.toContain("ungroup");
  });

  it("forme -> remplissage/bordure PUIS le socle commun", () => {
    const ks = kinds(toolbarActionsFor([shapeLayer()]));
    expect(ks.slice(0, 2)).toEqual(["fill", "border"]);
    expect(ks).toContain("duplicate");
  });

  it("image -> remplacer/ajustement PUIS le socle commun", () => {
    const ks = kinds(toolbarActionsFor([imageLayer()]));
    expect(ks.slice(0, 2)).toEqual(["replace", "fit"]);
  });

  it("QR -> emplacement PUIS le socle commun", () => {
    const ks = kinds(toolbarActionsFor([qrLayer()]));
    expect(ks.slice(0, 1)).toEqual(["qrSlot"]);
  });

  // NON-VACUITÉ (brief, « anti-vacuity ») : l'ensemble d'un calque TEXTE n'est PAS celui d'un calque
  // FORME — une implémentation qui renverrait le même socle pour tous les types rougirait ici.
  it("ANTI-VACUITÉ : l'ensemble d'un texte diffère de celui d'une forme, d'une image, d'un QR", () => {
    const text = kinds(toolbarActionsFor([textLayer()]));
    const shape = kinds(toolbarActionsFor([shapeLayer()]));
    const image = kinds(toolbarActionsFor([imageLayer()]));
    const qr = kinds(toolbarActionsFor([qrLayer()]));
    expect(text).not.toEqual(shape);
    expect(text).not.toEqual(image);
    expect(text).not.toEqual(qr);
    expect(shape).not.toEqual(image);
    expect(shape).not.toEqual(qr);
    expect(image).not.toEqual(qr);
  });
});

describe("toolbarActionsFor — verrouiller reflète l'état de la sélection", () => {
  it("« Verrouiller » pour un calque DÉVERROUILLÉ, « Déverrouiller » pour un calque verrouillé", () => {
    const unlocked = toolbarActionsFor([textLayer({ locked: false })]).find((a) => a.kind === "lock")!;
    const locked = toolbarActionsFor([textLayer({ locked: true })]).find((a) => a.kind === "lock")!;
    expect(unlocked.label).toBe("Verrouiller");
    expect(locked.label).toBe("Déverrouiller");
  });

  it("un LOT MIXTE (un verrouillé, un non) reste « Verrouiller », pas « Déverrouiller »", () => {
    const action = toolbarActionsFor([
      shapeLayer({ id: "a", locked: true }),
      shapeLayer({ id: "b", locked: false }),
    ]).find((a) => a.kind === "lock")!;
    expect(action.label).toBe("Verrouiller");
  });
});

describe("toolbarActionsFor — PLUSIEURS calques -> UNIQUEMENT le socle commun", () => {
  it("deux calques de TYPES DIFFÉRENTS -> aucune action par type", () => {
    const ks = kinds(toolbarActionsFor([textLayer(), shapeLayer()]));
    expect(ks).not.toContain("font");
    expect(ks).not.toContain("fill");
    expect(ks).toContain("duplicate");
    expect(ks).toContain("delete");
    expect(ks).toContain("lock");
    expect(ks).toContain("bringForward");
    expect(ks).toContain("sendBackward");
  });

  // MUTATION (brief, Étape 3) : « renvoyer le même socle pour tous les types » ferait passer ce test
  // — c'est précisément le test « UN calque » ci-dessus (qui exige `font`/`fill`/… en tête) qui
  // rougirait alors, prouvant que les deux chemins sont bien distincts dans l'implémentation.
  it("deux calques du MÊME type (texte, texte) -> aucune action par type non plus", () => {
    const ks = kinds(toolbarActionsFor([textLayer({ id: "t1" }), textLayer({ id: "t2" })]));
    expect(ks).not.toContain("font");
    expect(ks).not.toContain("bold");
  });

  it("sélection multiple AD HOC (pas un groupe existant) -> propose GROUPER", () => {
    const ks = kinds(toolbarActionsFor([shapeLayer({ id: "a" }), shapeLayer({ id: "b" })]));
    expect(ks).toContain("group");
    expect(ks).not.toContain("ungroup");
  });

  it("sélection = un GROUPE ENTIER (même groupId partagé) -> propose DÉGROUPER, pas grouper", () => {
    const ks = kinds(toolbarActionsFor([
      shapeLayer({ id: "a", groupId: "g1" }),
      shapeLayer({ id: "b", groupId: "g1" }),
    ]));
    expect(ks).toContain("ungroup");
    expect(ks).not.toContain("group");
  });

  it("deux GROUPES DIFFÉRENTS mélangés (ex. ⌘A) -> propose GROUPER, pas dégrouper", () => {
    const ks = kinds(toolbarActionsFor([
      shapeLayer({ id: "a", groupId: "g1" }),
      shapeLayer({ id: "b", groupId: "g1" }),
      shapeLayer({ id: "c", groupId: "g2" }),
      shapeLayer({ id: "d", groupId: "g2" }),
    ]));
    expect(ks).toContain("group");
    expect(ks).not.toContain("ungroup");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bloc 2 — composition réelle : `FloatingToolbar` monté DANS `Canvas` (Étape 3 du brief).

function makeScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      textLayer({ id: "title", frame: { x: 40, y: 40, w: 300, h: 80 } }),
      shapeLayer({ id: "rect", frame: { x: 400, y: 200, w: 120, h: 120 } }),
    ],
  };
}

let teardownDom: () => void;
beforeAll(() => { teardownDom = installDom(); });
afterAll(() => { teardownDom(); });

describe("FloatingToolbar — composition dans Canvas (U0 harnais)", () => {
  it("une sélection texte affiche la barre TEXTE, en FRÈRE dans le conteneur mis à l'échelle", async () => {
    const scene = makeScene();
    const { container, unmount } = await mount(
      React.createElement(Canvas, {
        scene, selectedIds: ["title"], dispatch: () => {}, scale: 1,
      }),
    );
    try {
      const toolbar = container.querySelector('[data-testid="floating-toolbar"]');
      expect(toolbar).not.toBeNull();
      // FRÈRE des calques, PAS un enfant du calque sélectionné (jamais un descendant du nœud
      // `data-layer-id="title"` — sinon un clic sur la barre serait aussi un clic sur le calque).
      const layerNode = container.querySelector('[data-layer-id="title"]');
      expect(layerNode?.contains(toolbar)).toBe(false);
      // Le conteneur PARENT direct de la barre est bien le conteneur mis à l'échelle (celui qui
      // porte `transform: scale(…)`), pas un conteneur à côté de l'artboard — même garde que le
      // contour « liaisons » (U4 Tâche 6).
      const scaled = container.querySelector('[data-testid="studio-canvas"]')?.firstElementChild;
      expect(scaled?.contains(toolbar)).toBe(true);

      // Barre TEXTE : le bouton "Gras" (propre au type) est présent ; "Remplissage" (forme) ne
      // l'est pas — anti-vacuité observée EN COMPOSITION, pas seulement côté module pur.
      expect(container.querySelector('[data-action="bold"]')).not.toBeNull();
      expect(container.querySelector('[data-action="fill"]')).toBeNull();
      expect(container.querySelector('[data-action="duplicate"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("aucune sélection -> aucune barre (le canevas reste inchangé, spec §0)", async () => {
    const scene = makeScene();
    const { container, unmount } = await mount(
      React.createElement(Canvas, { scene, selectedIds: [], dispatch: () => {}, scale: 1 }),
    );
    try {
      expect(container.querySelector('[data-testid="floating-toolbar"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it("un clic RÉEL sur « Dupliquer » dispatche addLayers avec un clone de la sélection", async () => {
    const scene = makeScene();
    const dispatched: unknown[] = [];
    const { container, unmount } = await mount(
      React.createElement(Canvas, {
        scene, selectedIds: ["rect"], dispatch: (a: unknown) => dispatched.push(a), scale: 1,
      }),
    );
    try {
      const button = container.querySelector('[data-action="duplicate"]') as HTMLElement;
      expect(button).not.toBeNull();
      await click(button);
      expect(dispatched.length).toBe(1);
      const action = dispatched[0] as { type: string; layers: Layer[] };
      expect(action.type).toBe("addLayers");
      expect(action.layers.length).toBe(1);
      expect(action.layers[0].id).not.toBe("rect"); // id NEUF, jamais le même que la source.
      expect(action.layers[0].type).toBe("shape");
    } finally {
      unmount();
    }
  });

  it("PENDANT un glisser (preview actif) -> la barre disparaît", async () => {
    const scene = makeScene();
    const { container, unmount } = await mount(
      React.createElement(Canvas, {
        scene, selectedIds: ["rect"], dispatch: () => {}, scale: 1,
      }),
    );
    try {
      expect(container.querySelector('[data-testid="floating-toolbar"]')).not.toBeNull();
      const layerEl = container.querySelector('[data-layer-id="rect"]') as HTMLElement;
      await pointer(layerEl, "pointerdown", { clientX: 460, clientY: 260, button: 0 });
      // pointermove/pointerup ciblent le MÊME élément que pointerdown : `bind()`
      // (hooks/use-layer-drag.ts) pose ses écouteurs sur `e.currentTarget`, jamais sur
      // `window`/`document` (`setPointerCapture` route tout vers cet élément) — même idiome que
      // tests/studio-interactions.test.ts.
      await pointer(layerEl, "pointermove", { clientX: 480, clientY: 280, button: 0 });
      // Le geste est bien ARMÉ (un déplacement de 20px en x/y a eu lieu) — sinon ce test passerait
      // sans jamais avoir prouvé que `preview` était réellement actif.
      expect(container.querySelector('[data-testid="floating-toolbar"]')).toBeNull();
      await pointer(layerEl, "pointerup", { clientX: 480, clientY: 280, button: 0 });
      // Le geste relâché -> la barre réapparaît (le calque reste sélectionné après un glisser).
      expect(container.querySelector('[data-testid="floating-toolbar"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });
});
