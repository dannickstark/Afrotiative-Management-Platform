import { describe, it, expect } from "bun:test";
import { FORMAT_PRESETS } from "@/lib/studio/formats";
import { parseScene, SceneError, type Scene } from "@/lib/studio/scene";

const valid: Scene = {
  schemaVersion: 1,
  canvas: { width: 1200, height: 675, background: "#000000" },
  layers: [
    { id: "l1", name: "Fond", visible: true, locked: false, frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover", blur: 24, overlay: "#000000A6" },
    { id: "l2", name: "Titre", visible: true, locked: false, frame: { x: 80, y: 400, w: 1040, h: 200 },
      type: "text", content: "{{article.title}}", font: { family: "Noto Sans", size: 64, weight: 700 },
      color: "#FFFFFF", align: "left", vAlign: "bottom", lineHeight: 1.1, maxLines: 3 },
  ],
};

describe("parseScene", () => {
  it("accepte une scène valide et la renvoie typée", () => {
    expect(parseScene(structuredClone(valid)).layers).toHaveLength(2);
  });

  it("refuse une version de schéma inconnue", () => {
    expect(() => parseScene({ ...structuredClone(valid), schemaVersion: 2 })).toThrow(SceneError);
  });

  it("refuse un type de calque inconnu", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { type: string }).type = "video";
    expect(() => parseScene(bad)).toThrow(SceneError);
  });

  it("refuse deux calques partageant le même identifiant", () => {
    const bad = structuredClone(valid);
    bad.layers[1].id = "l1";
    expect(() => parseScene(bad)).toThrow(/identifiant/i);
  });

  it("refuse une couleur hexadécimale malformée", () => {
    const bad = structuredClone(valid);
    bad.canvas.background = "rouge";
    expect(() => parseScene(bad)).toThrow(SceneError);
  });
});

describe("FORMAT_PRESETS", () => {
  it("expose les sept préréglages avec des dimensions positives", () => {
    const keys = Object.keys(FORMAT_PRESETS);
    expect(keys).toHaveLength(7);
    for (const k of keys) {
      const p = FORMAT_PRESETS[k as keyof typeof FORMAT_PRESETS];
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });
});
