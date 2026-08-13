import { describe, expect, it } from "bun:test";
import {
  clampZoom, nextZoom, unionBounds, zoomPresetScale, ZOOM_STEPS, wheelZoomScale, zoomAtCursor,
} from "@/lib/studio/zoom";

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

// ─────────────────────────────────────────────────────────────────────────────
// Chantier B, Tâche 4 — pan (Espace-glisser) + zoom molette centré curseur, en PUR.

describe("wheelZoomScale — deltaY négatif AGRANDIT, deltaY positif RÉDUIT, réponse continue à l'amplitude", () => {
  it("deltaY = 0 -> l'échelle ne change pas", () => {
    expect(wheelZoomScale(1, 0)).toBe(1);
    expect(wheelZoomScale(2.5, 0)).toBe(2.5);
  });

  it("deltaY négatif (molette vers le haut / pincement « écarter ») agrandit strictement", () => {
    expect(wheelZoomScale(1, -100)).toBeGreaterThan(1);
    expect(wheelZoomScale(1, -10)).toBeGreaterThan(1);
  });

  it("deltaY positif (molette vers le bas / pincement « rapprocher ») réduit strictement", () => {
    expect(wheelZoomScale(1, 100)).toBeLessThan(1);
    expect(wheelZoomScale(1, 10)).toBeLessThan(1);
  });

  it("un plus GRAND |deltaY| produit un changement d'échelle plus IMPORTANT — pas un pas fixe par événement", () => {
    const small = wheelZoomScale(1, -10);
    const large = wheelZoomScale(1, -100);
    expect(large - 1).toBeGreaterThan(small - 1);
  });

  it("une entrée non finie renvoie prevScale INCHANGÉE, jamais NaN propagé", () => {
    expect(wheelZoomScale(NaN, -10)).toBeNaN(); // NaN reste NaN quand c'est lui-même l'entrée corrompue…
    expect(wheelZoomScale(1, NaN)).toBe(1); // …mais un deltaY corrompu, lui, ne doit RIEN changer à une échelle saine
    expect(wheelZoomScale(1, Infinity)).toBe(1);
  });
});

describe("zoomAtCursor — le point du CANEVAS sous le curseur reste EXACTEMENT fixe (Chantier B, Tâche 4)", () => {
  const viewport = { width: 800, height: 600 };

  function canvasPointFor(scale: number, cursor: { x: number; y: number }, scroll: { x: number; y: number }) {
    return { x: (scroll.x + cursor.x) / scale, y: (scroll.y + cursor.y) / scale };
  }

  it("le point canevas sous le curseur AVANT == APRÈS, balayé sur plusieurs combinaisons d'échelle/curseur/défilement", () => {
    const cases = [
      { prevScale: 1, nextScale: 2, cursor: { x: 100, y: 50 }, scroll: { x: 0, y: 0 } },
      { prevScale: 0.5, nextScale: 1, cursor: { x: 300, y: 200 }, scroll: { x: 150, y: 80 } },
      { prevScale: 2, nextScale: 0.5, cursor: { x: 10, y: 400 }, scroll: { x: 500, y: 300 } },
      { prevScale: 1, nextScale: 1, cursor: { x: 250, y: 250 }, scroll: { x: 42, y: 17 } }, // sans changement d'échelle
      { prevScale: 0.31, nextScale: 8, cursor: { x: 0, y: 0 }, scroll: { x: 0, y: 0 } }, // coin haut-gauche, bornes extrêmes
      { prevScale: 8, nextScale: 0.1, cursor: { x: 799, y: 599 }, scroll: { x: 1200, y: 900 } }, // coin bas-droit du viewport
    ];
    for (const c of cases) {
      const before = canvasPointFor(c.prevScale, c.cursor, c.scroll);
      const result = zoomAtCursor(c.prevScale, c.nextScale, c.cursor, c.scroll, viewport);
      expect(result.scale).toBe(c.nextScale);
      const after = canvasPointFor(c.nextScale, c.cursor, result.scroll);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it("anti-vacuité : SANS la correction de défilement (scroll laissé tel quel), le point dériverait — la fonction, elle, corrige bien", () => {
    const prevScale = 1;
    const nextScale = 2;
    const cursor = { x: 100, y: 50 };
    const scroll = { x: 0, y: 0 };
    const result = zoomAtCursor(prevScale, nextScale, cursor, scroll, viewport);
    // Le mutant décrit par le brief (« drop the scroll adjustment ») renverrait `scroll` inchangé —
    // ce test prouve que ce mutant-là romprait bien le point fixe, donc que `result.scroll` DOIT
    // différer de `scroll` ici pour que le point reste fixe.
    expect(result.scroll).not.toEqual(scroll);
    const driftedAfter = canvasPointFor(nextScale, cursor, scroll); // le mutant : scroll NON corrigé
    const before = canvasPointFor(prevScale, cursor, scroll);
    expect(driftedAfter.x).not.toBeCloseTo(before.x, 9); // le point DÉRIVE bien sans la correction
  });

  it("continuité : un tout petit changement d'échelle produit un tout petit changement de défilement, jamais un saut", () => {
    const prevScale = 1;
    const cursor = { x: 400, y: 300 };
    const scroll = { x: 120, y: 90 };
    let previous = zoomAtCursor(prevScale, prevScale, cursor, scroll, viewport);
    for (let i = 1; i <= 50; i += 1) {
      const nextScale = prevScale + i * 0.001; // pas de 0,001 en 0,001, balayé
      const result = zoomAtCursor(prevScale, nextScale, cursor, scroll, viewport);
      expect(Math.abs(result.scroll.x - previous.scroll.x)).toBeLessThan(1);
      expect(Math.abs(result.scroll.y - previous.scroll.y)).toBeLessThan(1);
      previous = result;
    }
  });

  it("échelle INCHANGÉE (prevScale === nextScale) -> le défilement ne bouge pas non plus", () => {
    const scroll = { x: 77, y: 33 };
    const result = zoomAtCursor(1.5, 1.5, { x: 200, y: 150 }, scroll, viewport);
    expect(result.scroll.x).toBeCloseTo(scroll.x, 9);
    expect(result.scroll.y).toBeCloseTo(scroll.y, 9);
  });
});
