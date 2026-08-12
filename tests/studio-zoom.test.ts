import { describe, expect, it } from "bun:test";
import { clampZoom, nextZoom, unionBounds, zoomPresetScale, ZOOM_STEPS } from "@/lib/studio/zoom";

// tests/studio-zoom.test.ts — Chantier B, Tâche 3 : lib/studio/zoom.ts en PUR (aucun DOM/React), sur
// le modèle de tests/studio-keymap.test.ts. `clampZoom`/`nextZoom`/`zoomPresetScale` sont des
// FONCTIONS DE CHOIX (leçon U2, task-3-brief.md) : balayées pas à pas, pas seulement à une valeur
// centrale — un mutant qui décalerait une borne d'un cran doit rougir au moins un `it`.

describe("clampZoom — bornes 0,1–8 (les extrémités de ZOOM_STEPS)", () => {
  it("une valeur DÉJÀ dans les bornes traverse inchangée", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it("sous le minimum -> ramenée au minimum", () => {
    expect(clampZoom(0)).toBe(ZOOM_STEPS[0]);
    expect(clampZoom(-5)).toBe(ZOOM_STEPS[0]);
    expect(clampZoom(0.05)).toBe(ZOOM_STEPS[0]);
  });

  it("au-dessus du maximum -> ramenée au maximum", () => {
    expect(clampZoom(8.01)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(clampZoom(1000)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });

  it("PILE sur une borne -> inchangée (bornes INCLUSIVES)", () => {
    expect(clampZoom(0.1)).toBe(0.1);
    expect(clampZoom(8)).toBe(8);
  });

  it("une valeur non finie retombe sur 1 (« l'ajustement »), jamais NaN propagé", () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
    expect(clampZoom(-Infinity)).toBe(1);
  });
});

describe("nextZoom — balaie CHAQUE pas de ZOOM_STEPS dans les deux directions", () => {
  it("depuis chaque pas, zoomer AVANT (+1) avance exactement au pas suivant", () => {
    for (let i = 0; i < ZOOM_STEPS.length - 1; i += 1) {
      expect(nextZoom(ZOOM_STEPS[i], 1)).toBe(ZOOM_STEPS[i + 1]);
    }
  });

  it("depuis chaque pas, zoomer ARRIÈRE (-1) recule exactement au pas précédent", () => {
    for (let i = ZOOM_STEPS.length - 1; i > 0; i -= 1) {
      expect(nextZoom(ZOOM_STEPS[i], -1)).toBe(ZOOM_STEPS[i - 1]);
    }
  });

  it("au pas MAXIMUM, zoomer encore AVANT reste sur le maximum (saturation, pas de sortie de tableau)", () => {
    const max = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    expect(nextZoom(max, 1)).toBe(max);
  });

  it("au pas MINIMUM, zoomer encore ARRIÈRE reste sur le minimum", () => {
    const min = ZOOM_STEPS[0];
    expect(nextZoom(min, -1)).toBe(min);
  });

  it("un facteur CONTINU entre deux pas (ex. après un zoom sur sélection) avance/recule au premier pas STRICTEMENT au-delà, jamais le plus proche", () => {
    // 1.1 est plus proche de 1 que de 1.25, mais avancer doit quand même viser 1.25 (le premier pas
    // strictement supérieur) — pas de retour en arrière vers 1.
    expect(nextZoom(1.1, 1)).toBe(1.25);
    expect(nextZoom(1.1, -1)).toBe(1);
  });

  it("un facteur hors bornes est d'abord ramené dans les bornes avant de chercher le pas suivant", () => {
    expect(nextZoom(100, 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(nextZoom(-100, -1)).toBe(ZOOM_STEPS[0]);
  });

  it("anti-vacuité : avancer puis reculer depuis un pas intermédiaire revient EXACTEMENT au point de départ", () => {
    const start = ZOOM_STEPS[4];
    const forward = nextZoom(start, 1);
    expect(forward).not.toBe(start);
    expect(nextZoom(forward, -1)).toBe(start);
  });
});

describe("unionBounds — la boîte englobante d'une sélection", () => {
  it("tableau vide -> null (rien à cadrer)", () => {
    expect(unionBounds([])).toBeNull();
  });

  it("une seule boîte -> elle-même", () => {
    expect(unionBounds([{ x: 10, y: 20, w: 30, h: 40 }])).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it("plusieurs boîtes -> l'union exacte (min des coins haut-gauche, max des coins bas-droit)", () => {
    const boxes = [
      { x: 0, y: 0, w: 10, h: 10 }, // coin bas-droit (10,10)
      { x: 50, y: -20, w: 5, h: 5 }, // coin bas-droit (55,-15)
    ];
    expect(unionBounds(boxes)).toEqual({ x: 0, y: -20, w: 55, h: 30 });
  });
});

describe("zoomPresetScale(\"fit\", …) — toujours 1, quel que soit fitScale", () => {
  it("1 pour n'importe quel fitScale — scale = fitScale × 1 = fitScale, comportement d'AVANT cette tâche", () => {
    expect(zoomPresetScale("fit", 0.3)).toBe(1);
    expect(zoomPresetScale("fit", 1)).toBe(1);
    expect(zoomPresetScale("fit", 2)).toBe(1);
  });
});

describe("zoomPresetScale(\"100\", …) — l'artboard au pixel natif, quel que soit fitScale", () => {
  it("le facteur renvoyé, multiplié par fitScale, redonne exactement 1 (100 % absolu)", () => {
    for (const fitScale of [0.2, 0.31, 0.5, 1, 2]) {
      const factor = zoomPresetScale("100", fitScale);
      expect(factor * fitScale).toBeCloseTo(1, 10);
    }
  });

  it("passe par clampZoom : un fitScale minuscule ne produit pas un facteur qui dépasse le maximum", () => {
    const factor = zoomPresetScale("100", 0.001); // sans clamp : 1/0.001 = 1000
    expect(factor).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });
});

describe("zoomPresetScale(\"selection\", …) — cadre la boîte englobante dans le viewport", () => {
  it("cadre une sélection carrée dans un viewport carré : absoluteTarget = (viewport/box) × 0,9, puis / fitScale", () => {
    const fitScale = 0.5;
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    const viewport = { width: 1000, height: 1000 };
    // absoluteTarget = min(1000/100, 1000/100) × 0.9 = 9 ; facteur = 9 / 0.5 = 18 -> clampé à 8.
    expect(zoomPresetScale("selection", fitScale, bounds, viewport)).toBe(8);
  });

  it("le côté LIMITANT est celui qui contraint le plus (le plus petit ratio viewport/boîte)", () => {
    const fitScale = 1;
    const bounds = { x: 0, y: 0, w: 100, h: 50 }; // large sélection
    const viewport = { width: 400, height: 100 }; // hauteur limitante : 100/50=2 < 400/100=4
    const expected = (100 / 50) * 0.9; // 1.8
    expect(zoomPresetScale("selection", fitScale, bounds, viewport)).toBeCloseTo(expected, 10);
  });

  it("selectionBounds absent -> replie sur 1 (comme \"fit\")", () => {
    expect(zoomPresetScale("selection", 0.5, undefined, { width: 500, height: 500 })).toBe(1);
  });

  it("viewport absent -> replie sur 1", () => {
    expect(zoomPresetScale("selection", 0.5, { x: 0, y: 0, w: 10, h: 10 }, undefined)).toBe(1);
  });

  it("boîte de largeur ou hauteur nulle -> replie sur 1 (rien de valide à cadrer)", () => {
    expect(zoomPresetScale("selection", 0.5, { x: 0, y: 0, w: 0, h: 10 }, { width: 500, height: 500 })).toBe(1);
    expect(zoomPresetScale("selection", 0.5, { x: 0, y: 0, w: 10, h: 0 }, { width: 500, height: 500 })).toBe(1);
  });

  it("viewport de largeur ou hauteur nulle -> replie sur 1", () => {
    expect(zoomPresetScale("selection", 0.5, { x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 500 })).toBe(1);
    expect(zoomPresetScale("selection", 0.5, { x: 0, y: 0, w: 10, h: 10 }, { width: 500, height: 0 })).toBe(1);
  });

  it("passe par clampZoom : une sélection minuscule dans un grand viewport ne dépasse pas le maximum", () => {
    const factor = zoomPresetScale("selection", 1, { x: 0, y: 0, w: 1, h: 1 }, { width: 2000, height: 2000 });
    expect(factor).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });
});
