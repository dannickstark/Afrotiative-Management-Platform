import { describe, expect, it } from "bun:test";
import { scrubValue, valueToFraction, sliderValue, opacityToPercent, percentToOpacity } from "@/lib/studio/field-scrub";

describe("scrubValue (fonction de choix — balayer)", () => {
  it("dx=0 laisse la valeur inchangée (point-zéro)", () => {
    expect(scrubValue(50, 0, { step: 1 })).toBe(50);
  });
  it("continuité : un petit dx donne un petit delta, monotone", () => {
    const a = scrubValue(0, 4, { step: 1 });   // 1 pas
    const b = scrubValue(0, 8, { step: 1 });   // 2 pas
    expect(a).toBe(1); expect(b).toBe(2);
  });
  it("Maj multiplie par 10, Alt par 0.1", () => {
    expect(scrubValue(0, 40, { step: 1, modifier: "shift" })).toBe(100); // 10 pas × 10
    expect(scrubValue(0, 40, { step: 1, modifier: "alt" })).toBe(1);     // 10 pas × 0.1
  });
  it("clampe à [min,max]", () => {
    expect(scrubValue(0, -400, { step: 1, min: 0 })).toBe(0);
    expect(scrubValue(0, 4000, { step: 1, max: 100 })).toBe(100);
  });
  it("respecte le step (arrondi au multiple du step)", () => {
    // 8px @ 4px/pas = 2 pas ; step 5 → +10
    expect(scrubValue(10, 8, { step: 5, pxPerStep: 4 })).toBe(20);
    // une valeur hors-grille est ramenée sur la grille du step
    expect(scrubValue(0, 6, { step: 0.5, pxPerStep: 4 })).toBe(1); // raw 0.75 → arrondi à la grille 0.5 → 1.0
  });
});

describe("curseur ↔ fraction (aller-retour)", () => {
  it("valueToFraction et sliderValue sont inverses au step près", () => {
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const v = sliderValue(f, { min: 0, max: 200, step: 1 });
      expect(valueToFraction(v, 0, 200)).toBeCloseTo(f, 2);
    }
  });
  it("valueToFraction clampe hors bornes", () => {
    expect(valueToFraction(-10, 0, 100)).toBe(0);
    expect(valueToFraction(999, 0, 100)).toBe(1);
  });
});

describe("opacité", () => {
  it("0..1 ↔ 0..100 aller-retour aux valeurs rondes", () => {
    expect(opacityToPercent(0.5)).toBe(50);
    expect(percentToOpacity(50)).toBeCloseTo(0.5, 5);
    expect(opacityToPercent(1)).toBe(100);
    expect(opacityToPercent(0)).toBe(0);
  });
  it("percentToOpacity clampe", () => {
    expect(percentToOpacity(150)).toBe(1);
    expect(percentToOpacity(-5)).toBe(0);
  });
});
