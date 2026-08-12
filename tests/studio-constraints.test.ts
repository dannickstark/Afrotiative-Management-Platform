import { describe, it, expect } from "bun:test";
import { constraintsOf, parseScene, type Layer, type Scene } from "@/lib/studio/scene";

// ─────────────────────────────────────────────────────────────────────────────
// Chantier D, Tâche 1 — CONTRAINTES par calque (h/v) et SURCHARGES par format sur la scène.
//
// MIGRATION NO-OP, énoncée explicitement : les deux champs sont NOUVEAUX et OPTIONNELS. Une scène
// déjà écrite (ni `constraints` sur un calque, ni `formatOverrides` sur la scène) se relit
// EXACTEMENT comme avant — `constraintsOf` retombe alors sur `{ h: "left", v: "top" }`, le
// comportement d'aujourd'hui (un calque est ancré en haut à gauche par défaut).
// ─────────────────────────────────────────────────────────────────────────────

function textLayer(overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id: "l2",
    name: "Titre",
    visible: true,
    locked: false,
    frame: { x: 80, y: 400, w: 1040, h: 200 },
    type: "text",
    content: "{{article.title}}",
    font: { family: "Noto Sans", size: 64, weight: 700 },
    color: "#FFFFFF",
    align: "left",
    vAlign: "bottom",
    lineHeight: 1.1,
    maxLines: 3,
    ...overrides,
  } as Layer;
}

const baseScene: Scene = {
  schemaVersion: 1,
  canvas: { width: 1200, height: 675, background: "#000000" },
  layers: [
    {
      id: "l1", name: "Fond", visible: true, locked: false, frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
    },
  ],
};

function sceneWith(layer: Layer): Scene {
  return { ...baseScene, layers: [...baseScene.layers, layer] };
}

describe("constraintsOf", () => {
  it("retombe sur { h: left, v: top } pour un calque sans constraints", () => {
    expect(constraintsOf(textLayer({}))).toEqual({ h: "left", v: "top" });
  });

  it("renvoie la valeur stockée quand elle est présente", () => {
    expect(constraintsOf(textLayer({ constraints: { h: "leftRight", v: "center" } })))
      .toEqual({ h: "leftRight", v: "center" });
  });
});

describe("parseScene — constraints et formatOverrides", () => {
  it("accepte un calque avec des constraints valides", () => {
    expect(() => parseScene(sceneWith(textLayer({ constraints: { h: "leftRight", v: "top" } })))).not.toThrow();
  });

  it("accepte une scène avec formatOverrides", () => {
    expect(() => parseScene({
      ...baseScene,
      formatOverrides: { ig_square: { l1: { x: 0, y: 0, w: 10, h: 10 } } },
    })).not.toThrow();
  });

  it("refuse un enum invalide pour h", () => {
    const badConstraints = { h: "middle", v: "top" } as unknown as { h: "left"; v: "top" };
    expect(() => parseScene(sceneWith(textLayer({ constraints: badConstraints })))).toThrow();
  });

  // ANTI-VACUITÉ : une scène SANS constraints ni formatOverrides reste légale — l'absence est le
  // comportement d'aujourd'hui, pas une régression à corriger.
  it("une scène SANS constraints ni formatOverrides reste légale", () => {
    expect(() => parseScene(sceneWith(textLayer({})))).not.toThrow();
    const parsed = parseScene(sceneWith(textLayer({})));
    expect("constraints" in parsed.layers[1]).toBe(false);
    expect("formatOverrides" in parsed).toBe(false);
  });

  // MIGRATION NO-OP (load-bearing) : une scène stockée SANS ces champs fait un aller-retour par
  // parseScene strictement inchangée (deep-equal), preuve que l'ajout est purement additif.
  it("migration no-op : une scène sans constraints/formatOverrides round-trip inchangée", () => {
    const stored = sceneWith(textLayer({}));
    const roundTripped = parseScene(structuredClone(stored));
    expect(roundTripped).toEqual(stored);
  });
});
