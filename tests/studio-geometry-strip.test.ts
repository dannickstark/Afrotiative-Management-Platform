// tests/studio-geometry-strip.test.ts — Chantier D, Tâche 3 : la note « texte contraint qui déborde
// maxLines » dans la bande de géométrie (components/studio/geometry-strip.tsx). MÊME ton et MÊME
// placement que les notes de rotation déjà épinglées par tests/studio-property-panel.test.ts, mais
// CE test-ci monte le VRAI composant sous jsdom (U0, tests/dom-harness.ts) plutôt que du HTML statique
// — parce qu'il affirme l'ÉGALITÉ de la propriété accessible réelle (`.textContent`) contre le texte
// attendu, pas une simple sous-chaîne dans un balayage de markup brut.
//
// `textOverflowsMaxLines` (le prop qui pilote la note) vient d'un VRAI appel à
// `constrainedTextOverflows` (lib/studio/relayout-warn.ts, Tâche 3 — mesuré au rendu satori, jamais
// deviné) : voir le commentaire de ce prop sur GeometryStripProps pour la raison structurelle
// (frontière "use client" / node:fs) pour laquelle le COMPOSANT ne peut pas l'appeler lui-même. Ce
// choix rend la paire positive/négative ci-dessous NON VACUEUSE — la Tâche « MUTATION » du rapport
// (rendre `constrainedTextOverflows` toujours fausse) fait effectivement rougir le cas positif, ce
// qu'une simple bascule manuelle du prop dans le test n'aurait pas prouvé.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import React from "react";
import { installDom, mount, click } from "./dom-harness";
import type { Layer, Scene, TextLayer } from "@/lib/studio/scene";
import { constrainedTextOverflows } from "@/lib/studio/relayout-warn";
import { relayoutToFormat } from "@/lib/studio/relayout";
import { GeometryStrip, maxLinesOverflowNote } from "@/components/studio/geometry-strip";
// Chantier D, Tâche 4 — le widget de contraintes (ConstraintsField) est monté DANS GeometryStrip
// (voir la place réservée par U1 : « U5 y ajoutera le widget d'ancrage par côté »), donc ses tests
// DOM vivent ICI plutôt que dans un fichier séparé — c'est tests/studio-constraints-field.test.ts qui
// tient la logique PURE (`nextConstraintOnEdgeClick`, sans DOM). `H_CONSTRAINT_LABELS`/
// `V_CONSTRAINT_LABELS` sont importés pour affirmer le TEXTE accessible réel des deux menus contre
// LA MÊME table que le composant, jamais une chaîne recopiée à la main (même idiome que
// `maxLinesOverflowNote` ci-dessus).
import { H_CONSTRAINT_LABELS, V_CONSTRAINT_LABELS } from "@/components/studio/constraints-field";
import { setLayerProps, type EditorAction } from "@/lib/studio/editor-state";

// Globals que jsdom 30 (sans `pretendToBeVisual`) ne fournit pas, et que `installDom()` n'installe
// PAS (§2 du plan U0 : window/document/navigator/HTMLElement/Node/Event/KeyboardEvent/MouseEvent/
// IntersectionObserver/localStorage — pas ceux-ci) — `ConstraintsField` (Chantier D, Tâche 4) monte
// deux `<Select>` de @/components/ui/select (Base UI), qui construit un contexte floating-ui-react
// DÈS le montage, PAS seulement à l'ouverture : `floating-ui-react` fait `value instanceof Element`
// (le `Element` GLOBAL nu, pas `window.Element`) et calcule un positionnement (`getComputedStyle`, via
// une promesse planifiée par `requestAnimationFrame`) même pour un popup fermé. Sans ces globals,
// monter GeometryStrip lève `ReferenceError: Element is not defined` au tout premier rendu — mesuré
// (voir la trace RED de ce fichier avant ce correctif). MÊME solution, MÊME portée que
// tests/studio-interactions.test.ts#installExtraGlobals (jamais migrée dans dom-harness.ts partagé —
// décision documentée là-bas), reprise ici plutôt que dupliquée en aveugle : ce fichier est le second
// à avoir besoin d'un `<Select>` sous ce harnais, PAS le premier.
function installExtraGlobals(): () => void {
  const g = globalThis as unknown as Record<string, unknown> & { window: Record<string, unknown> };
  const snapshot = new Map<string, { had: boolean; value: unknown }>();
  const set = (key: string, value: unknown) => {
    snapshot.set(key, { had: Object.prototype.hasOwnProperty.call(g, key), value: g[key] });
    g[key] = value;
  };

  set("Element", g.window.Element);
  set("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
  set("cancelAnimationFrame", (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  set("getComputedStyle", (g.window.getComputedStyle as (...a: unknown[]) => unknown).bind(g.window));

  return () => {
    for (const [key, prior] of snapshot) {
      if (prior.had) g[key] = prior.value;
      else delete g[key];
    }
  };
}

let teardownDom: () => void;
let teardownExtraGlobals: () => void;
beforeAll(() => { teardownDom = installDom(); teardownExtraGlobals = installExtraGlobals(); });
afterAll(() => { teardownExtraGlobals(); teardownDom(); });

// Même scénario numérique que tests/studio-relayout.test.ts (« constrainedTextOverflows — un texte
// contraint... ») : 1 ligne à 1520px (le format d'accueil, x_landscape 1600×900, moins 40px de marge
// de chaque côté), 2 lignes une fois relayouté vers « story » (1080×1920) — leftRight ->
// 1520 + (1080-1600) = 1000px, où le même titre déborde `maxLines: 1`.
const TITLE = "Le cacao camerounais bat un record d'exportation";

function titleLayer(overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    id: "title", name: "Titre", visible: true, locked: false,
    frame: { x: 40, y: 40, w: 1520, h: 300 },
    constraints: { h: "leftRight", v: "top" },
    type: "text",
    content: TITLE,
    font: { family: "Noto Sans", size: 48, weight: 700 },
    color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    maxLines: 1,
    ...overrides,
  };
}

function sceneWith(layer: TextLayer): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1600, height: 900, background: "#000000" },
    layers: [layer as unknown as Layer],
  };
}

const noop = () => {};

describe("GeometryStrip — note « texte contraint qui déborde maxLines » (chantier D T3)", () => {
  it("le calque déborde dans « story » : la note apparaît, avec le texte accessible EXACT", async () => {
    const layer = titleLayer();
    const scene = sceneWith(layer);
    // VRAI débordement, mesuré au rendu — pas un booléen inventé pour le test.
    const overflows = await constrainedTextOverflows(scene, layer, "story");
    expect(overflows).toBe(true); // prémisse du test : si ceci échoue, le reste ne prouve rien.

    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, {
        layer, patch: noop, scene, selectedIds: [layer.id], dispatch: noop,
        textOverflowsMaxLines: overflows, previewFormat: "story",
      }),
    );
    try {
      const note = container.querySelector('[data-testid="text-maxlines-overflow-note"]');
      expect(note).not.toBeNull();
      // ÉGALITÉ EXACTE contre la propriété accessible réelle — pas `.toContain`, pas une sous-chaîne.
      expect(note!.textContent).toBe(maxLinesOverflowNote(1, "story"));
      expect(note!.textContent).toBe(
        "Texte contraint en largeur : le retour à la ligne change dans « Story (Instagram / WhatsApp) » "
        + "et dépasse la limite de 1 ligne posée sur ce calque — le surplus sera coupé au rendu (maxLines).",
      );
    } finally {
      unmount();
    }
  });

  // ── Négatif jumeau — ANTI-VACUITÉ : le MÊME calque, mesuré au format d'accueil (relayoutToFormat y
  // est l'identité, chantier D Tâche 2 — 1 ligne tient dans maxLines:1), ne montre AUCUNE note. Sans
  // ce témoin, un composant qui afficherait TOUJOURS la note passerait quand même le test positif
  // ci-dessus. ──────────────────────────────────────────────────────────────────────────────────
  it("le MÊME calque, au format d'accueil (tient dans maxLines) : AUCUNE note", async () => {
    const layer = titleLayer();
    const scene = sceneWith(layer);
    const overflows = await constrainedTextOverflows(scene, layer, "x_landscape");
    expect(overflows).toBe(false); // prémisse du test.

    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, {
        layer, patch: noop, scene, selectedIds: [layer.id], dispatch: noop,
        textOverflowsMaxLines: overflows, previewFormat: "x_landscape",
      }),
    );
    try {
      expect(container.querySelector('[data-testid="text-maxlines-overflow-note"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it("un calque NON texte (forme) : jamais de note, même si le prop est fourni à tort par un appelant amont", async () => {
    const shape: Layer = {
      id: "s1", name: "Forme", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 100, h: 100 }, type: "shape", shape: "rect", fill: "#FFFFFF",
    };
    const scene: Scene = { schemaVersion: 1, canvas: { width: 1600, height: 900, background: "#000000" }, layers: [shape] };
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, {
        layer: shape, patch: noop, scene, selectedIds: [shape.id], dispatch: noop,
        textOverflowsMaxLines: true, previewFormat: "story",
      }),
    );
    try {
      expect(container.querySelector('[data-testid="text-maxlines-overflow-note"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it("sans `textOverflowsMaxLines` fourni (appelant qui ne l'a pas encore branché) : aucune note, jamais un mensonge par défaut optimiste", async () => {
    const layer = titleLayer();
    const scene = sceneWith(layer);
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, { layer, patch: noop, scene, selectedIds: [layer.id], dispatch: noop }),
    );
    try {
      expect(container.querySelector('[data-testid="text-maxlines-overflow-note"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it("sans `previewFormat` : la note reste honnête, sans NOMMER de format inexistant", () => {
    expect(maxLinesOverflowNote(2)).toBe(
      "Texte contraint en largeur : le retour à la ligne change et dépasse la limite de 2 lignes posée sur ce calque — le surplus sera coupé au rendu (maxLines).",
    );
  });

  // ── Garde-fou structurel — la scène du test ci-dessus PROUVE réellement le scénario numérique
  // (1520px -> 1 ligne, 1000px -> 2 lignes) plutôt que de le supposer : redondant avec
  // tests/studio-relayout.test.ts, gardé ici pour que ce fichier reste lisible seul.
  it("garde-fou : le calque relayouté vers « story » atteint bien 1000px de large (leftRight)", () => {
    const layer = titleLayer();
    const scene = sceneWith(layer);
    const relaid = relayoutToFormat(scene, "story");
    expect(relaid.layers[0].frame.w).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chantier D, Tâche 4 — le widget de contraintes (ConstraintsField), monté dans GeometryStrip.
function shapeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: "l1", name: "Forme", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 100, h: 100 }, type: "shape", shape: "rect", fill: "#FFFFFF",
    ...overrides,
  } as Layer;
}

function shapeScene(...layers: Layer[]): Scene {
  return { schemaVersion: 1, canvas: { width: 1600, height: 900, background: "#000000" }, layers };
}

describe("GeometryStrip — le widget de contraintes (ConstraintsField, chantier D T4)", () => {
  it("le carré reflète constraintsOf(layer) : aria-pressed VRAI sur les bords posés, FAUX ailleurs", async () => {
    const layer = shapeLayer({ constraints: { h: "leftRight", v: "center" } });
    const scene = shapeScene(layer);
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, { layer, patch: () => {}, scene, selectedIds: [layer.id], dispatch: () => {} }),
    );
    try {
      const pressed = (edge: string) =>
        container.querySelector(`[data-edge="${edge}"]`)!.getAttribute("aria-pressed");
      // h:"leftRight" -> les DEUX bords horizontaux posés ; v:"center" -> aucun bord vertical, et le
      // centre lui-même FAUX (le centre n'est actif que quand LES DEUX axes valent "center").
      expect(pressed("left")).toBe("true");
      expect(pressed("right")).toBe("true");
      expect(pressed("top")).toBe("false");
      expect(pressed("bottom")).toBe("false");
      expect(pressed("center")).toBe("false");
    } finally {
      unmount();
    }
  });

  it("le centre reflète VRAI seulement quand LES DEUX axes valent \"center\"", async () => {
    const layer = shapeLayer({ constraints: { h: "center", v: "center" } });
    const scene = shapeScene(layer);
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, { layer, patch: () => {}, scene, selectedIds: [layer.id], dispatch: () => {} }),
    );
    try {
      expect(container.querySelector('[data-edge="center"]')!.getAttribute("aria-pressed")).toBe("true");
    } finally {
      unmount();
    }
  });

  it("les menus H/V affichent le TEXTE accessible EXACT de constraintsOf(layer)", async () => {
    const layer = shapeLayer({ constraints: { h: "leftRight", v: "topBottom" } });
    const scene = shapeScene(layer);
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, { layer, patch: () => {}, scene, selectedIds: [layer.id], dispatch: () => {} }),
    );
    try {
      // `[data-slot="select-value"]`, PAS le déclencheur entier : celui-ci porte aussi l'icône
      // chevron (`ChevronDownIcon`), qui ajoute son propre texte de repli au `.textContent` du
      // conteneur — comparer le déclencheur entier comparerait donc « Gauche et droite▼ » à
      // « Gauche et droite », un écart qui n'a rien à voir avec ce que ce test affirme.
      const hValue = container.querySelector('[data-field="constraints.h"] [data-slot="select-value"]');
      const vValue = container.querySelector('[data-field="constraints.v"] [data-slot="select-value"]');
      expect(hValue).not.toBeNull();
      expect(vValue).not.toBeNull();
      expect(hValue!.textContent).toBe(H_CONSTRAINT_LABELS.leftRight);
      expect(vValue!.textContent).toBe(V_CONSTRAINT_LABELS.topBottom);
      expect(hValue!.textContent).toBe("Gauche et droite");
      expect(vValue!.textContent).toBe("Haut et bas");
    } finally {
      unmount();
    }
  });

  it("cliquer le bord droit (calque par défaut h:\"left\") DISPATCHE un correctif h:\"leftRight\" via patch", async () => {
    // Aucun `constraints` écrit -> `constraintsOf` retombe sur { h: "left", v: "top" } (T1) : le bord
    // gauche est donc déjà posé, et cliquer le bord OPPOSÉ (droit) promeut la paire en étirement —
    // exactement la règle vérifiée sans DOM dans tests/studio-constraints-field.test.ts.
    const layer = shapeLayer();
    const scene = shapeScene(layer);
    const patches: Record<string, unknown>[] = [];
    const patch = (p: Record<string, unknown>) => patches.push(p);
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, { layer, patch, scene, selectedIds: [layer.id], dispatch: () => {} }),
    );
    try {
      const rightEdge = container.querySelector('[data-edge="right"]')!;
      expect(rightEdge.getAttribute("aria-pressed")).toBe("false"); // prémisse : pas encore posé
      await click(rightEdge);
      expect(patches.length).toBe(1);
      expect(patches[0]).toEqual({ constraints: { h: "leftRight", v: "top" } });
    } finally {
      unmount();
    }
  });

  it("Maj-clic sur le bord droit applique le correctif à TOUTE la sélection multiple via dispatch(setLayerProps)", async () => {
    const layer1 = shapeLayer({ id: "l1" });
    const layer2 = shapeLayer({ id: "l2", frame: { x: 200, y: 0, w: 50, h: 50 } });
    const scene = shapeScene(layer1, layer2);
    const patches: Record<string, unknown>[] = [];
    const dispatched: EditorAction[] = [];
    const patch = (p: Record<string, unknown>) => patches.push(p);
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, {
        layer: layer1, patch, scene, selectedIds: [layer1.id, layer2.id], dispatch: (a: EditorAction) => dispatched.push(a),
      }),
    );
    try {
      const rightEdge = container.querySelector('[data-edge="right"]')!;
      await click(rightEdge, { shiftKey: true });
      // Maj-clic : le lot passe par `dispatch(setLayerProps(...))`, JAMAIS par `patch()` (qui n'édite
      // que le calque courant) — sinon la sélection multiple n'aurait reçu qu'UNE entrée d'historique
      // pour UN seul calque au lieu d'un vrai lot.
      expect(patches.length).toBe(0);
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]).toEqual(setLayerProps([layer1.id, layer2.id], { constraints: { h: "leftRight", v: "top" } }));
    } finally {
      unmount();
    }
  });

  it("SANS Maj (même sélection multiple) : clic normal reste borné au calque courant via patch, jamais dispatch", async () => {
    const layer1 = shapeLayer({ id: "l1" });
    const layer2 = shapeLayer({ id: "l2", frame: { x: 200, y: 0, w: 50, h: 50 } });
    const scene = shapeScene(layer1, layer2);
    const patches: Record<string, unknown>[] = [];
    const dispatched: EditorAction[] = [];
    const patch = (p: Record<string, unknown>) => patches.push(p);
    const { container, unmount } = await mount(
      React.createElement(GeometryStrip, {
        layer: layer1, patch, scene, selectedIds: [layer1.id, layer2.id], dispatch: (a: EditorAction) => dispatched.push(a),
      }),
    );
    try {
      const rightEdge = container.querySelector('[data-edge="right"]')!;
      await click(rightEdge); // pas de shiftKey
      expect(dispatched.length).toBe(0);
      expect(patches.length).toBe(1);
      expect(patches[0]).toEqual({ constraints: { h: "leftRight", v: "top" } });
    } finally {
      unmount();
    }
  });
});
