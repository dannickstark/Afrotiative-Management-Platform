import { describe, expect, it } from "bun:test";
import { centeredFrame, textFrameFor } from "@/lib/studio/layer-geometry";

// tests/studio-layer-geometry.test.ts — Correctif revue finale (Minor) : `centeredFrame`/
// `textFrameFor` remplacent deux copies quasi identiques qui vivaient auparavant dans
// dynamic-text.ts et shape-gallery.ts (chacune avec son propre test indirect, jamais direct). Ce
// fichier couvre la SEULE source désormais partagée par les trois chemins d'insertion par clic
// (Texte dynamique, Styles, Éléments).
describe("centeredFrame — centré, jamais plus grand que le canevas, jamais hors de ses bords", () => {
  it("centre exactement une boîte plus petite que le canevas", () => {
    const f = centeredFrame({ width: 1000, height: 1000 }, 200, 100);
    expect(f).toEqual({ x: 400, y: 450, w: 200, h: 100 });
  });

  it("borne une boîte plus large que le canevas à la largeur du canevas", () => {
    const f = centeredFrame({ width: 500, height: 1000 }, 2000, 100);
    expect(f.w).toBe(500);
    expect(f.x).toBe(0);
    expect(f.x + f.w).toBeLessThanOrEqual(500);
  });

  it("borne une boîte plus haute que le canevas à la hauteur du canevas", () => {
    const f = centeredFrame({ width: 1000, height: 300 }, 200, 2000);
    expect(f.h).toBe(300);
    expect(f.y).toBe(0);
    expect(f.y + f.h).toBeLessThanOrEqual(300);
  });

  it("jamais une largeur/hauteur nulle ou négative, même pour un canevas minuscule", () => {
    const f = centeredFrame({ width: 1, height: 1 }, -50, 0);
    expect(f.w).toBeGreaterThanOrEqual(1);
    expect(f.h).toBeGreaterThanOrEqual(1);
  });

  it("reste dans le canevas pour un format très étroit (story, 1080×1920) comme pour un format très large (lien, 1200×630)", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1200, height: 630 }]) {
      const f = centeredFrame(canvas, canvas.width * 0.9, 80);
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(canvas.width);
      expect(f.y + f.h).toBeLessThanOrEqual(canvas.height);
    }
  });
});

describe("textFrameFor — relatif à la taille de police et à la marge, jamais fixe", () => {
  it("une police plus grande produit une boîte plus haute", () => {
    const small = textFrameFor({ width: 1200, height: 630 }, 20);
    const large = textFrameFor({ width: 1200, height: 630 }, 60);
    expect(large.h).toBeGreaterThan(small.h);
  });

  it("la largeur est relative au canevas (marge de 8% de chaque côté), pas fixe", () => {
    const narrow = textFrameFor({ width: 800, height: 800 }, 30);
    const wide = textFrameFor({ width: 1600, height: 800 }, 30);
    expect(wide.w).toBeGreaterThan(narrow.w);
    expect(narrow.w).toBeCloseTo(800 * 0.84, 5);
  });

  it("atterrit toujours DANS le canevas, y compris pour une police énorme sur un petit format", () => {
    const f = textFrameFor({ width: 400, height: 300 }, 500);
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.x + f.w).toBeLessThanOrEqual(400);
    expect(f.y + f.h).toBeLessThanOrEqual(300);
  });
});
