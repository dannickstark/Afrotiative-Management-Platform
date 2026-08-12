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
import { installDom, mount } from "./dom-harness";
import type { Layer, Scene, TextLayer } from "@/lib/studio/scene";
import { constrainedTextOverflows } from "@/lib/studio/relayout-warn";
import { relayoutToFormat } from "@/lib/studio/relayout";
import { GeometryStrip, maxLinesOverflowNote } from "@/components/studio/geometry-strip";

let teardownDom: () => void;
beforeAll(() => { teardownDom = installDom(); });
afterAll(() => { teardownDom(); });

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
