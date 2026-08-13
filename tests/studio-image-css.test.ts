import { describe, it, expect } from "bun:test";
import {
  imageCss, focalToPosition, focalToPositionPx, tileToRepeat, type ImageLayer,
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
