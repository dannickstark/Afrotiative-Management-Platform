import { describe, it, expect } from "bun:test";
import {
  relayoutAxis,
  relayoutFrame,
  relayout,
  relayoutToFormat,
} from "@/lib/studio/relayout";
import {
  H_CONSTRAINTS,
  V_CONSTRAINTS,
  constraintsOf,
  type Layer,
  type Scene,
  type LayerConstraints,
} from "@/lib/studio/scene";
import { FORMAT_PRESETS, FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";

// ─────────────────────────────────────────────────────────────────────────────
// Chantier D, Tâche 2 — LE moteur pur `relayout`. Chaque calque porte deux contraintes
// indépendantes (h, v) qui gouvernent comment son cadre s'ajuste quand le CANEVAS change de
// dimension (ex. le même gabarit décliné du format « site » vers « story »). Ce fichier épingle
// d'abord la table de vérité PAR AXE (donnée verbatim par le brief), puis les propriétés du moteur
// complet : identité au format d'accueil (migration no-op), préservation des écarts/centre/échelle,
// et la fonction de choix surcharge-vs-contrainte.
// ─────────────────────────────────────────────────────────────────────────────

function shapeLayer(overrides: Partial<Layer> & Record<string, unknown> = {}): Layer {
  return {
    id: "l1",
    name: "Forme",
    visible: true,
    locked: false,
    frame: { x: 100, y: 100, w: 200, h: 100 },
    type: "shape",
    shape: "rect",
    fill: "#FFFFFF",
    ...overrides,
  } as Layer;
}

function sceneOf(layers: Layer[], canvas = { width: 1000, height: 800, background: "#000000" }): Scene {
  return { schemaVersion: 1, canvas, layers };
}

// ── Étape 1 : la table de vérité PAR AXE — donnée verbatim par le brief (base 1000 → cible 500,
// pos 100, taille 200). ──────────────────────────────────────────────────────────────────────────
describe("relayoutAxis — table de vérité par axe (base 1000 → cible 500, pos 100, taille 200)", () => {
  it("left : garde l'écart gauche", () => {
    expect(relayoutAxis(100, 200, 1000, 500, "left")).toEqual({ pos: 100, size: 200 });
  });

  it("right : garde l'écart droit (1000-300=700 → 500-700-200 = -400)", () => {
    expect(relayoutAxis(100, 200, 1000, 500, "right")).toEqual({ pos: 100 + (500 - 1000), size: 200 });
  });

  it("leftRight : garde les deux écarts, étire (nouvelle taille = 500-100-700 = -300, clampée au niveau du cadre)", () => {
    expect(relayoutAxis(100, 200, 1000, 500, "leftRight")).toEqual({ pos: 100, size: 500 - 100 - (1000 - 300) });
  });

  it("center : garde le décalage au centre (centre 200, centre canevas 500, décalage -300 → nouveau centre 250-300=-50 → pos -150)", () => {
    expect(relayoutAxis(100, 200, 1000, 500, "center")).toEqual({ pos: 500 / 2 + (100 + 100 - 1000 / 2) - 100, size: 200 });
  });

  it("scale : proportionnel", () => {
    expect(relayoutAxis(100, 200, 1000, 500, "scale")).toEqual({ pos: 50, size: 100 });
  });
});

// ── Identité au format d'accueil — LE no-op de migration. Pour N'IMPORTE QUEL jeu de contraintes,
// relayouter vers les dimensions ACTUELLES doit rendre la scène bit pour bit identique. ───────────
describe("relayout — identité au format d'accueil (migration no-op)", () => {
  const canvas = { width: 1200, height: 675, background: "#111111" };

  for (const h of H_CONSTRAINTS) {
    for (const v of V_CONSTRAINTS) {
      it(`identité pour { h: ${h}, v: ${v} }`, () => {
        const scene = sceneOf(
          [shapeLayer({ constraints: { h, v }, frame: { x: 37, y: 58, w: 213, h: 149 } })],
          canvas,
        );
        const result = relayout(scene, { w: scene.canvas.width, h: scene.canvas.height });
        expect(result).toEqual(scene);
      });
    }
  }

  it("identité même pour un calque SANS constraints (défaut left/top)", () => {
    const scene = sceneOf([shapeLayer({ frame: { x: 10, y: 20, w: 300, h: 150 } })], canvas);
    const result = relayout(scene, { w: scene.canvas.width, h: scene.canvas.height });
    expect(result).toEqual(scene);
  });

  it("identité pour plusieurs calques mêlés, incluant tous les FORMAT_PRESETS comme canevas d'accueil", () => {
    for (const key of FORMAT_KEYS) {
      const preset = FORMAT_PRESETS[key];
      const scene = sceneOf(
        [
          shapeLayer({ id: "a", constraints: { h: "leftRight", v: "center" }, frame: { x: 5, y: 5, w: 50, h: 40 } }),
          shapeLayer({ id: "b", constraints: { h: "scale", v: "scale" }, frame: { x: 20, y: 30, w: 60, h: 25 } }),
          shapeLayer({ id: "c", constraints: { h: "right", v: "bottom" }, frame: { x: 3, y: 3, w: 10, h: 10 } }),
        ],
        { width: preset.width, height: preset.height, background: "#000000" },
      );
      const result = relayout(scene, { w: preset.width, h: preset.height });
      expect(result).toEqual(scene);
    }
  });

  it("ne mute jamais la scène d'entrée", () => {
    const scene = sceneOf([shapeLayer({ constraints: { h: "scale", v: "scale" } })], canvas);
    const before = structuredClone(scene);
    relayout(scene, { w: 400, h: 300 });
    expect(scene).toEqual(before);
  });
});

// ── Préservation des écarts / centre / échelle — testée sur `relayoutAxis` directement (avant tout
// clamp de taille minimale) pour rester valide même quand la taille traversée devient négative. ──
describe("relayoutAxis — préservation numérique (5×5 × plusieurs paires base→cible, dont les 8 FORMAT_PRESETS)", () => {
  const widths = FORMAT_KEYS.map((k) => FORMAT_PRESETS[k].width);
  const heights = FORMAT_KEYS.map((k) => FORMAT_PRESETS[k].height);
  const extraPairs = [
    [1000, 500], [500, 1000], [800, 800], [333, 777],
  ];

  function checkAxis(pos: number, size: number, base: number, target: number, mode: string) {
    const { pos: newPos, size: newSize } = relayoutAxis(pos, size, base, target, mode as never);
    switch (mode) {
      case "left":
      case "top":
        expect(newPos).toBe(pos);
        expect(newSize).toBe(size);
        break;
      case "right":
      case "bottom": {
        expect(newSize).toBe(size);
        const origFarGap = base - (pos + size);
        const newFarGap = target - (newPos + newSize);
        expect(newFarGap).toBeCloseTo(origFarGap, 9);
        break;
      }
      case "leftRight":
      case "topBottom": {
        expect(newPos).toBe(pos); // écart proche préservé
        const origFarGap = base - (pos + size);
        const newFarGap = target - (newPos + newSize);
        expect(newFarGap).toBeCloseTo(origFarGap, 9);
        break;
      }
      case "center": {
        expect(newSize).toBe(size);
        const origOffset = pos + size / 2 - base / 2;
        const newOffset = newPos + newSize / 2 - target / 2;
        expect(newOffset).toBeCloseTo(origOffset, 9);
        break;
      }
      case "scale": {
        expect(newPos * base).toBeCloseTo(pos * target, 6);
        expect(newSize * base).toBeCloseTo(size * target, 6);
        break;
      }
    }
  }

  const pairs = [...extraPairs, ...widths.map((w, i) => [w, widths[(i + 3) % widths.length]])];
  const vPairs = [...extraPairs, ...heights.map((h, i) => [h, heights[(i + 3) % heights.length]])];

  for (const mode of H_CONSTRAINTS) {
    for (const [base, target] of pairs) {
      it(`H ${mode} : ${base} → ${target}`, () => {
        checkAxis(97, 211, base, target, mode);
      });
    }
  }

  for (const mode of V_CONSTRAINTS) {
    for (const [base, target] of vPairs) {
      it(`V ${mode} : ${base} → ${target}`, () => {
        checkAxis(41, 163, base, target, mode);
      });
    }
  }
});

describe("relayoutFrame — clamp de taille minimale", () => {
  it("clampe une taille négative/nulle à 1 (jamais moins)", () => {
    const c: LayerConstraints = { h: "leftRight", v: "topBottom" };
    // base 1000 → cible 500 : taille = size + (target - base) = 200 + (-500) = -300 → clampée à 1.
    const frame = relayoutFrame({ x: 100, y: 100, w: 200, h: 200 }, c, { w: 1000, h: 1000 }, { w: 500, h: 500 });
    expect(frame.w).toBe(1);
    expect(frame.h).toBe(1);
    // La position, elle, n'est jamais clampée.
    expect(frame.x).toBe(100);
    expect(frame.y).toBe(100);
  });

  it("laisse une taille positive intacte", () => {
    const c: LayerConstraints = { h: "scale", v: "scale" };
    const frame = relayoutFrame({ x: 100, y: 100, w: 200, h: 100 }, c, { w: 1000, h: 800 }, { w: 2000, h: 1600 });
    expect(frame).toEqual({ x: 200, y: 200, w: 400, h: 200 });
  });
});

// ── Les surcharges par format GAGNENT — anti-vacuité : un AUTRE format continue d'utiliser la
// contrainte, preuve que le chemin « contrainte » est bien emprunté quand aucune surcharge ne
// correspond (et pas seulement quand toutes les surcharges sont absentes). ────────────────────────
describe("relayout — les surcharges par format gagnent (anti-vacuité)", () => {
  const canvas = { width: 1200, height: 675, background: "#000000" };
  const overrideFrame = { x: 9, y: 9, w: 42, h: 42 };

  function sceneWithOverride(): Scene {
    return {
      ...sceneOf(
        [shapeLayer({ id: "l1", constraints: { h: "scale", v: "scale" }, frame: { x: 100, y: 100, w: 200, h: 100 } })],
        canvas,
      ),
      formatOverrides: { ig_square: { l1: overrideFrame } },
    };
  }

  it("ig_square : utilise la surcharge, ignore la contrainte scale", () => {
    const scene = sceneWithOverride();
    const result = relayoutToFormat(scene, "ig_square");
    expect(result.layers[0].frame).toEqual(overrideFrame);
  });

  it("story (format DIFFÉRENT, sans surcharge) : retombe bien sur la contrainte scale", () => {
    const scene = sceneWithOverride();
    const result = relayoutToFormat(scene, "story");
    const expected = relayoutFrame(
      scene.layers[0].frame,
      constraintsOf(scene.layers[0]),
      { w: canvas.width, h: canvas.height },
      { w: FORMAT_PRESETS.story.width, h: FORMAT_PRESETS.story.height },
    );
    expect(result.layers[0].frame).toEqual(expected);
    expect(result.layers[0].frame).not.toEqual(overrideFrame);
  });

  it("relayout brut sans formatKey n'applique JAMAIS de surcharge (elle exige la clé de format)", () => {
    const scene = sceneWithOverride();
    const result = relayout(scene, { w: FORMAT_PRESETS.ig_square.width, h: FORMAT_PRESETS.ig_square.height });
    expect(result.layers[0].frame).not.toEqual(overrideFrame);
  });
});

// ── La sélection surcharge-vs-contrainte est une FONCTION DE CHOIX : déterministe, indifférente à
// l'ordre d'insertion des clés dans la carte de surcharges. ────────────────────────────────────────
describe("relayout — la sélection surcharge-vs-contrainte est déterministe (indifférente à l'ordre des clés)", () => {
  it("même résultat quel que soit l'ordre d'insertion des formats dans formatOverrides", () => {
    const canvas = { width: 1200, height: 675, background: "#000000" };
    const layers = [
      shapeLayer({ id: "a", constraints: { h: "scale", v: "scale" }, frame: { x: 10, y: 10, w: 50, h: 50 } }),
      shapeLayer({ id: "b", constraints: { h: "leftRight", v: "center" }, frame: { x: 5, y: 5, w: 80, h: 30 } }),
    ];

    const sceneOrderA: Scene = {
      ...sceneOf(layers, canvas),
      formatOverrides: {
        ig_square: { a: { x: 1, y: 1, w: 2, h: 2 } },
        story: { b: { x: 3, y: 3, w: 4, h: 4 } },
        fb_link: { a: { x: 5, y: 5, w: 6, h: 6 } },
      },
    };
    // Même contenu, clés insérées dans l'ordre INVERSE.
    const sceneOrderB: Scene = {
      ...sceneOf(layers, canvas),
      formatOverrides: {
        fb_link: { a: { x: 5, y: 5, w: 6, h: 6 } },
        story: { b: { x: 3, y: 3, w: 4, h: 4 } },
        ig_square: { a: { x: 1, y: 1, w: 2, h: 2 } },
      },
    };

    for (const key of ["ig_square", "story", "fb_link", "wa_square"] as FormatKey[]) {
      expect(relayoutToFormat(sceneOrderA, key)).toEqual(relayoutToFormat(sceneOrderB, key));
    }
  });
});

// ── Garde-fou structurel : `relayoutToFormat` doit produire un canevas qui correspond EXACTEMENT
// aux dimensions du préréglage — un format ajouté sans dimensions ferait rougir ce test. ──────────
describe("relayoutToFormat — garde-fou structurel sur les dimensions du canevas", () => {
  const scene = sceneOf([shapeLayer()], { width: 1200, height: 675, background: "#ABCDEF" });

  for (const key of FORMAT_KEYS) {
    it(`${key} : le canevas correspond à FORMAT_PRESETS.${key}`, () => {
      const result = relayoutToFormat(scene, key);
      expect(result.canvas.width).toBe(FORMAT_PRESETS[key].width);
      expect(result.canvas.height).toBe(FORMAT_PRESETS[key].height);
      expect(result.canvas.background).toBe(scene.canvas.background);
    });
  }
});
