import { describe, it, expect } from "bun:test";
import type { Layer, Scene } from "@/lib/studio/scene";
import { expandSelectionToGroups, groupBounds, nextGroupId } from "@/lib/studio/groups";

// tests/studio-groups.test.ts — Chantier B, Tâche 5 : les trois fonctions PURES de
// lib/studio/groups.ts, sur le modèle de tests/studio-align.test.ts (aucun DOM, aucun réducteur —
// juste des littéraux de calques/scène).

function shape(id: string, overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id, name: id, visible: true, locked: false,
    frame: { x: 0, y: 0, w: 100, h: 100 },
    type: "shape", shape: "rect", fill: "#123456",
    ...overrides,
  } as Layer;
}

function sceneOf(layers: Layer[]): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1200, height: 800, background: "#000000" },
    layers,
  };
}

describe("expandSelectionToGroups", () => {
  it("un calque MEMBRE renvoie TOUS les calques de son groupe, y compris lui-même", () => {
    const scene = sceneOf([
      shape("a", { groupId: "g1" }),
      shape("b", { groupId: "g1" }),
      shape("c"), // hors du groupe
    ]);
    expect(expandSelectionToGroups(["a"], scene)).toEqual(["a", "b"]);
    expect(expandSelectionToGroups(["b"], scene)).toEqual(["a", "b"]);
  });

  it("un calque SANS groupId (ou id absent de la scène) se renvoie lui-même, seul", () => {
    const scene = sceneOf([shape("a"), shape("b", { groupId: "g1" }), shape("c", { groupId: "g1" })]);
    expect(expandSelectionToGroups(["a"], scene)).toEqual(["a"]);
    expect(expandSelectionToGroups(["inexistant"], scene)).toEqual(["inexistant"]);
  });

  it("plusieurs groupes DIFFÉRENTS s'unissent correctement — pas de fusion croisée", () => {
    const scene = sceneOf([
      shape("a", { groupId: "g1" }),
      shape("b", { groupId: "g1" }),
      shape("c", { groupId: "g2" }),
      shape("d", { groupId: "g2" }),
      shape("e"),
    ]);
    expect(expandSelectionToGroups(["a", "c"], scene)).toEqual(["a", "b", "c", "d"]);
    // Chaque groupe reste ENTIER et distinct — jamais un membre de g1 mélangé à g2.
    const out = expandSelectionToGroups(["a", "c"], scene);
    expect(out).not.toContain("e");
  });

  it("une sélection déjà COMPLÈTE (tous les membres d'un groupe) est STABLE — idempotente", () => {
    const scene = sceneOf([
      shape("a", { groupId: "g1" }),
      shape("b", { groupId: "g1" }),
      shape("c", { groupId: "g1" }),
    ]);
    const once = expandSelectionToGroups(["a", "b", "c"], scene);
    const twice = expandSelectionToGroups(once, scene);
    expect(twice).toEqual(once);
    expect(once).toEqual(["a", "b", "c"]);
  });

  it("dédoublonne — deux ids du même groupe en entrée ne dupliquent pas ses membres", () => {
    const scene = sceneOf([shape("a", { groupId: "g1" }), shape("b", { groupId: "g1" })]);
    expect(expandSelectionToGroups(["a", "b"], scene)).toEqual(["a", "b"]);
    expect(expandSelectionToGroups(["a", "a"], scene)).toEqual(["a", "b"]);
  });

  it("une sélection VIDE renvoie une sélection VIDE", () => {
    const scene = sceneOf([shape("a", { groupId: "g1" })]);
    expect(expandSelectionToGroups([], scene)).toEqual([]);
  });

  // ANTI-VACUITÉ (brief, Step 4) : une implémentation qui renverrait TOUJOURS `[id]` tel quel (sans
  // jamais consulter `scene`) passerait les deux tests précédents mais échoue ICI — c'est le test qui
  // rougit si `expandSelectionToGroups` « oublie » d'étendre au groupe.
  it("anti-vacuité : le résultat pour un membre est bien PLUS GRAND que l'entrée, pas un simple passe-plat", () => {
    const scene = sceneOf([shape("a", { groupId: "g1" }), shape("b", { groupId: "g1" }), shape("c", { groupId: "g1" })]);
    const out = expandSelectionToGroups(["a"], scene);
    expect(out.length).toBeGreaterThan(1);
    expect(out).toEqual(["a", "b", "c"]);
  });
});

describe("groupBounds", () => {
  it("un calque UNIQUE : la boîte EST son cadre", () => {
    const layer = shape("a", { frame: { x: 10, y: 20, w: 100, h: 50 } });
    expect(groupBounds([layer])).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it("plusieurs calques : min x/y, max x+w/y+h — la boîte englobante exacte", () => {
    const layers = [
      shape("a", { frame: { x: 0, y: 0, w: 50, h: 50 } }),
      shape("b", { frame: { x: 200, y: 100, w: 40, h: 40 } }),
      shape("c", { frame: { x: -20, y: 300, w: 10, h: 10 } }),
    ];
    expect(groupBounds(layers)).toEqual({ x: -20, y: 0, w: 260, h: 310 });
  });

  // Décision explicite (même que boundingBox/align.ts, décision 1) : la rotation N'EST PAS prise en
  // compte — le cadre NON PIVOTÉ est utilisé tel quel, même si `layer.rotation` est posé.
  it("un calque PIVOTÉ utilise son cadre NON PIVOTÉ tel quel (pas de boîte englobante à l'écran)", () => {
    const rotated = shape("a", { frame: { x: 0, y: 0, w: 100, h: 100 }, rotation: 45 });
    const upright = shape("b", { frame: { x: 300, y: 300, w: 20, h: 20 } });
    expect(groupBounds([rotated, upright])).toEqual({ x: 0, y: 0, w: 320, h: 320 });
  });
});

describe("nextGroupId", () => {
  it("renvoie une chaîne", () => {
    expect(typeof nextGroupId()).toBe("string");
    expect(nextGroupId().length).toBeGreaterThan(0);
  });

  it("deux appels renvoient des ids DIFFÉRENTS", () => {
    expect(nextGroupId()).not.toBe(nextGroupId());
  });
});
