import { describe, it, expect } from "bun:test";
import {
  imageCss, focalToPosition, focalToPositionPx, tileBackgroundSize, tileToRepeat, type ImageLayer,
} from "@/lib/studio/image-css";

// ─────────────────────────────────────────────────────────────────────────────
// Properties Pro P1, Tâche 2 — le mappage CSS PUR du cadrage avancé d'une image. Module ZÉRO IMPORT
// (voir lib/studio/image-css.ts) : le type `ImageLayer` importé ici est celui LOCAL au module, pas
// celui de scene.ts — un `ImageLayer` de scene.ts le satisferait structurellement, mais ces tests
// n'ont pas besoin de zod pour exercer un mappage pur.
// ─────────────────────────────────────────────────────────────────────────────

function img(extra: Partial<ImageLayer>): ImageLayer {
  return {
    fit: "cover",
    frame: { x: 0, y: 0, w: 800, h: 400 },
    ...extra,
  };
}

describe("focalToPosition", () => {
  it("centre par défaut : absent et {0.5,0.5} donnent tous deux « 50% 50% »", () => {
    expect(focalToPosition()).toBe("50% 50%");
    expect(focalToPosition({ x: 0.5, y: 0.5 })).toBe("50% 50%");
  });

  it("coins exacts", () => {
    expect(focalToPosition({ x: 0, y: 1 })).toBe("0% 100%");
    expect(focalToPosition({ x: 1, y: 0 })).toBe("100% 0%");
    expect(focalToPosition({ x: 0, y: 0 })).toBe("0% 0%");
    expect(focalToPosition({ x: 1, y: 1 })).toBe("100% 100%");
  });

  it("une fraction quelconque, sans traîne de virgule flottante", () => {
    expect(focalToPosition({ x: 0.25, y: 0.75 })).toBe("25% 75%");
    // ANTI-VACUITÉ : 0.1 * 100 en JS brut donne 10.000000000000002 — la fonction doit l'éviter.
    expect(focalToPosition({ x: 0.1, y: 0.1 })).toBe("10% 10%");
  });
});

describe("tileToRepeat", () => {
  it("mappe chacun des trois axes vers le bon background-repeat", () => {
    expect(tileToRepeat({ scale: 1, axis: "x" })).toEqual({ backgroundRepeat: "repeat-x" });
    expect(tileToRepeat({ scale: 1, axis: "y" })).toEqual({ backgroundRepeat: "repeat-y" });
    expect(tileToRepeat({ scale: 1, axis: "both" })).toEqual({ backgroundRepeat: "repeat" });
  });

  it("l'absence de réglage de mosaïque équivaut à « both »", () => {
    expect(tileToRepeat()).toEqual({ backgroundRepeat: "repeat" });
    expect(tileToRepeat(undefined)).toEqual({ backgroundRepeat: "repeat" });
  });

  // ANTI-VACUITÉ : une mutation qui échangerait repeat-x/repeat-y ferait rougir CE test — pas de
  // simple présence/absence, une VRAIE distinction entre les deux axes.
  it("« x » et « y » ne sont PAS interchangeables", () => {
    expect(tileToRepeat({ scale: 1, axis: "x" }).backgroundRepeat)
      .not.toBe(tileToRepeat({ scale: 1, axis: "y" }).backgroundRepeat);
  });
});

describe("tileBackgroundSize — la taille de tuile de l'APERÇU, bornée au MÊME plafond que l'export (revue de branche)", () => {
  // Le cœur du correctif §0 : l'aperçu doit tuiler à l'intrinsèque BORNÉE (côté long ≤ 2×max(cadre)),
  // pas à la taille ORIGINALE de la source — sinon Montage (source originale) et Rendu réel (bornée)
  // tuilent à des tailles différentes dès qu'une photo dépasse le plafond.
  it("REPRO du brief : source 1200×800, cadre 300×300 (plafond 600), scale 1 → « 600px 400px » (bornée), PAS « 1200px 800px »", () => {
    const size = tileBackgroundSize({ w: 1200, h: 800 }, { w: 300, h: 300 }, 1);
    expect(size).toBe("600px 400px");
    // ANTI-VACUITÉ : ce n'est PAS la taille originale (que l'ancien "auto" aurait tuilée).
    expect(size).not.toBe("1200px 800px");
  });

  it("source SOUS le plafond : pas de bornage (facteur 1), tuile à la taille naturelle × scale", () => {
    // Cadre 300×300 → plafond 600 ; source 400×300 (côté long 400 < 600) reste telle quelle.
    expect(tileBackgroundSize({ w: 400, h: 300 }, { w: 300, h: 300 }, 1)).toBe("400px 300px");
  });

  it("le scale multiplie APRÈS le bornage (comme element.ts : intrinsèque bornée × scale)", () => {
    // Bornée 600×400, puis ×2.
    expect(tileBackgroundSize({ w: 1200, h: 800 }, { w: 300, h: 300 }, 2)).toBe("1200px 800px");
    // Bornée 400×300 (sous plafond), puis ×0.5.
    expect(tileBackgroundSize({ w: 400, h: 300 }, { w: 300, h: 300 }, 0.5)).toBe("200px 150px");
  });

  it("le plafond suit le CÔTÉ LONG du cadre (2×max(w,h)) et borne le côté long de la source", () => {
    // Cadre 100×300 → plafond 600 ; source 3000×1500 (côté long 3000) → facteur 600/3000 = 0.2 →
    // 600×300, arrondi à l'entier avant ×scale.
    expect(tileBackgroundSize({ w: 3000, h: 1500 }, { w: 100, h: 300 }, 1)).toBe("600px 300px");
  });
});

describe("imageCss", () => {
  it("cover/contain/stretch mappent le bon background-size, sans répétition", () => {
    expect(imageCss(img({ sizing: "cover" })).backgroundSize).toBe("cover");
    expect(imageCss(img({ sizing: "contain" })).backgroundSize).toBe("contain");
    expect(imageCss(img({ sizing: "stretch" })).backgroundSize).toBe("100% 100%");
    for (const sizing of ["cover", "contain", "stretch"] as const) {
      expect(imageCss(img({ sizing })).backgroundRepeat).toBe("no-repeat");
    }
  });

  it("tile mappe le bon background-repeat selon l'axe, et backgroundSize « auto »", () => {
    const t = imageCss(img({ sizing: "tile", tile: { scale: 0.5, axis: "x" } }));
    expect(t.backgroundRepeat).toBe("repeat-x");
    expect(t.backgroundSize).toBe("auto");

    const both = imageCss(img({ sizing: "tile", tile: { scale: 1, axis: "both" } }));
    expect(both.backgroundRepeat).toBe("repeat");
  });

  it("custom utilise customSize en pixels", () => {
    const c = imageCss(img({ sizing: "custom", customSize: { w: 300, h: 150 } }));
    expect(c.backgroundSize).toBe("300px 150px");
    expect(c.backgroundRepeat).toBe("no-repeat");
  });

  it("absent/legacy (fit seul) => cover|contain dérivé de fit, jamais de blend", () => {
    expect(imageCss(img({ fit: "cover" })).backgroundSize).toBe("cover");
    expect(imageCss(img({ fit: "contain" })).backgroundSize).toBe("contain");
    // PAS de backgroundBlendMode dans le résultat — adjudiqué à la Tâche 1 (spike).
    expect(imageCss(img({ fit: "cover" }))).not.toHaveProperty("backgroundBlendMode");
  });

  it("sizing prime sur fit quand les deux sont présents", () => {
    expect(imageCss(img({ fit: "cover", sizing: "contain" })).backgroundSize).toBe("contain");
    expect(imageCss(img({ fit: "contain", sizing: "stretch" })).backgroundSize).toBe("100% 100%");
  });

  it("backgroundPosition suit le point focal, centre par défaut", () => {
    expect(imageCss(img({})).backgroundPosition).toBe("50% 50%");
    expect(imageCss(img({ focal: { x: 0, y: 1 } })).backgroundPosition).toBe("0% 100%");
  });
});

describe("focalToPositionPx — la variante pixels pour Satori (Tâche 3)", () => {
  it("la formule CSS : (frame − effImg) × focal", () => {
    const layer = img({ frame: { x: 0, y: 0, w: 200, h: 200 }, focal: { x: 0.5, y: 0.5 } });
    expect(focalToPositionPx(layer, { w: 100, h: 100 })).toBe("50px 50px");
  });

  it("focal à 1 pousse l'image tout au bord opposé", () => {
    const layer = img({ frame: { x: 0, y: 0, w: 200, h: 200 }, focal: { x: 1, y: 1 } });
    expect(focalToPositionPx(layer, { w: 100, h: 100 })).toBe("100px 100px");
  });

  it("focal à 0 ancre l'image à l'origine", () => {
    const layer = img({ frame: { x: 0, y: 0, w: 200, h: 200 }, focal: { x: 0, y: 0 } });
    expect(focalToPositionPx(layer, { w: 100, h: 100 })).toBe("0px 0px");
  });

  it("absence de point focal équivaut au centre", () => {
    const layer = img({ frame: { x: 0, y: 0, w: 200, h: 200 } });
    expect(focalToPositionPx(layer, { w: 100, h: 100 })).toBe("50px 50px");
  });

  it("l'image effective peut dépasser le cadre (position négative) sans planter", () => {
    const layer = img({ frame: { x: 0, y: 0, w: 100, h: 100 }, focal: { x: 0.5, y: 0.5 } });
    expect(focalToPositionPx(layer, { w: 200, h: 200 })).toBe("-50px -50px");
  });
});
