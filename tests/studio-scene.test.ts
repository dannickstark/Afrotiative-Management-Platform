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
    expect(() => parseScene({ ...structuredClone(valid), schemaVersion: 2 })).toThrow(/Scène invalide.*attendu/i);
  });

  it("refuse un type de calque inconnu", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { type: string }).type = "video";
    expect(() => parseScene(bad)).toThrow(/Entrée invalide/i);
  });

  it("refuse deux calques partageant le même identifiant", () => {
    const bad = structuredClone(valid);
    bad.layers[1].id = "l1";
    expect(() => parseScene(bad)).toThrow(/identifiant.*double/i);
  });

  it("refuse une couleur hexadécimale malformée", () => {
    const bad = structuredClone(valid);
    bad.canvas.background = "rouge";
    expect(() => parseScene(bad)).toThrow(/Couleur invalide/i);
  });

  it("refuse un fit value invalide", () => {
    const bad = structuredClone(valid);
    (bad.layers[0] as unknown as { fit: string }).fit = "stretch";
    expect(() => parseScene(bad)).toThrow(/Scène invalide.*valeur parmi/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration de `radius` sur un calque FORME (U3 Tâche 2, arbitrage C / défaut de plan #12).
// La sonde a mesuré, à travers renderScene(), qu'un rayon NUMÉRIQUE ne peut pas exprimer une
// ellipse : sur 800×400, `radius: 200` donne un STADE. Le champ accepte donc désormais AUSSI une
// chaîne CSS — sans qu'aucune scène déjà écrite (rayon en pixels) ne se relise différemment.
// ─────────────────────────────────────────────────────────────────────────────
describe("parseScene — le rayon d'un calque forme", () => {
  function sceneWithRadius(radius: unknown) {
    return {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: "#000000" },
      layers: [{
        id: "s", name: "Forme", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 400 },
        type: "shape", shape: "rect", fill: "#FF0000",
        ...(radius === undefined ? {} : { radius }),
      }],
    };
  }
  function radiusOf(radius: unknown) {
    const layer = parseScene(sceneWithRadius(radius)).layers[0];
    if (layer.type !== "shape") throw new Error("calque inattendu");
    return layer.radius;
  }

  it("relit un rayon en PIXELS exactement comme avant la migration", () => {
    for (const value of [0, 1, 8.5, 60, 200, 2593]) {
      expect(radiusOf(value)).toBe(value);
    }
    expect(radiusOf(undefined)).toBeUndefined();
  });

  it("accepte désormais une chaîne CSS — c'est ce qui rend l'ellipse exprimable", () => {
    for (const value of ["50%", "0.5%", "8px", "100%", "8px 24px", "8px 24px 8px 24px"]) {
      expect(radiusOf(value)).toBe(value);
    }
  });

  it("refuse ce qui n'est ni un rayon en pixels ni une longueur CSS, en français", () => {
    for (const value of [-1, "banane", "50", "50 %", "8px 24px 8px 24px 8px", "50%;", true, {}]) {
      expect(() => parseScene(sceneWithRadius(value))).toThrow(SceneError);
      expect(() => parseScene(sceneWithRadius(value))).toThrow(/Rayon invalide/);
    }
  });
});

describe("FORMAT_PRESETS", () => {
  it("expose les huit préréglages avec des dimensions positives", () => {
    const keys = Object.keys(FORMAT_PRESETS);
    expect(keys).toHaveLength(8);
    for (const k of keys) {
      const p = FORMAT_PRESETS[k as keyof typeof FORMAT_PRESETS];
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });
});
